/**
 * @file shorts-twoperson-crop-regression.test.js
 * Regression tests for AI Shorts Studio Subject-Aware Cropping:
 * 1. Two-person landscape source converted to 9:16:
 *    - Both people have valid detections.
 *    - The selected subject's bounding box is preserved inside the portrait crop when geometrically possible.
 *    - The crop does not center on empty space when a valid person can be framed.
 *    - Coordinates remain correct across source and timeline coordinate systems.
 *    - Keyframe timestamps remain aligned with source timestamps.
 *    - "Edit in Timeline" preserves the calculated framing.
 * 2. Missing detections:
 *    - Triggers stable fallback rather than arbitrary background framing.
 *    - Correctly marks isFallback: true and state: "fallback" so UI never falsely claims "Subject-aware crop".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDynamicReframingTrack,
  generateFallbackReframingTrack,
  calculateTargetCropDimensions,
  selectPrimaryFace,
  solveFrameCrop,
  buildReframingFFmpegCropFilter,
} from "../../src/lib/shortsReframing.js";

import {
  convertCandidateToProject,
  discoverShortCandidates,
  isCandidateSmartFrameFallback,
} from "../../src/lib/shortsStudio.js";

import {
  resolveSmartFrameCropAtTime,
  smartFrameCropToPixels,
} from "../../src/lib/smartFrame.js";

import {
  getObjectPositionForCrop,
} from "../../src/lib/editorRuntime.js";

describe("AI Shorts Studio — Two-Person Subject-Aware Crop & Fallback Integrity", () => {
  const dummy16x9Source = {
    id: "src-two-person",
    name: "interview-twoperson.mp4",
    width: 1920,
    height: 1080,
    duration: 60,
    type: "video",
    src: "blob:http://localhost:5173/two-person-video",
  };

  // Synthetic deterministic two-person detections:
  // Person 1 (left): x in [0.15, 0.35], center at 0.25
  // Person 2 (right): x in [0.65, 0.85], center at 0.75
  // Center gap (empty wall/cabinet): x in [0.35, 0.65], center at 0.50
  const twoPersonDetections = [
    {
      time: 10,
      faces: [
        { xMin: 0.15, xMax: 0.35, yMin: 0.12, yMax: 0.45, confidence: 0.95, id: "person-left" },
        { xMin: 0.65, xMax: 0.85, yMin: 0.14, yMax: 0.44, confidence: 0.92, id: "person-right" },
      ],
    },
    {
      time: 15,
      faces: [
        { xMin: 0.16, xMax: 0.36, yMin: 0.12, yMax: 0.45, confidence: 0.96, id: "person-left" },
        { xMin: 0.64, xMax: 0.84, yMin: 0.14, yMax: 0.44, confidence: 0.91, id: "person-right" },
      ],
    },
    {
      time: 20,
      faces: [
        { xMin: 0.15, xMax: 0.35, yMin: 0.12, yMax: 0.45, confidence: 0.94, id: "person-left" },
        { xMin: 0.65, xMax: 0.85, yMin: 0.14, yMax: 0.44, confidence: 0.93, id: "person-right" },
      ],
    },
  ];

  describe("1. Two-person landscape source converted to 9:16 portrait", () => {
    it("preserves the selected subject inside the portrait crop and never centers on the empty center gap", () => {
      const cropDims = calculateTargetCropDimensions(
        { width: 1920, height: 1080 },
        "9:16"
      );
      assert.equal(cropDims.cropH, 1.0);
      assert.ok(Math.abs(cropDims.cropW - 0.3164) < 0.001, `Target crop width should be ~0.3164, got ${cropDims.cropW}`);

      // Two persons span from 0.15 to 0.85 (span 0.70), cannot both fit in 0.3164
      const primaryFace = selectPrimaryFace(
        twoPersonDetections[0].faces,
        null,
        {
          sourceSize: { width: 1920, height: 1080 },
          cropDims,
          targetRatio: "9:16",
        }
      );
      assert.ok(primaryFace, "Primary face must be selected");
      assert.equal(primaryFace.isGroup, undefined, "Multi-person wide span must not be flagged as fit-group");

      // Solved frame crop must center on the selected person
      const solvedCrop = solveFrameCrop(primaryFace, cropDims);
      assert.equal(Boolean(solvedCrop.isFallback), false, "Solved crop for detected person must not be fallback");
      assert.ok(solvedCrop.x < 0.25, `Crop x should frame left person, got x: ${solvedCrop.x}`);
      assert.ok(solvedCrop.x + solvedCrop.width > primaryFace.xMax, "Selected person must be fully enclosed in crop window");

      // Must NOT be the center gap [0.3418, 0.6582]
      assert.notEqual(solvedCrop.x, 0.3418, "Crop must not equal dead center x=0.3418");
      assert.ok(solvedCrop.panFactor < 0.35 || solvedCrop.panFactor > 0.65, "panFactor must not be centered (0.50)");
    });

    it("generates correct keyframes aligned with sourceStart during 'Edit in Timeline'", () => {
      const candidateStartTime = 10;
      const candidateEndTime = 25;
      const candidateDuration = 15;

      const discovery = discoverShortCandidates({
        sourceMedia: dummy16x9Source,
        settings: {
          aspectRatio: "9:16",
          autoReframing: "smart-subject",
          faceDetections: twoPersonDetections,
        },
      });
      assert.ok(discovery.ok);
      const cand = discovery.candidates[0];
      assert.ok(cand.smartFrame, "Candidate must receive a dynamic reframing track");
      assert.ok(cand.smartFrame.cropKeyframes.length > 0);

      // Verify candidate keyframes start at 0 relative to candidate
      const candFirstKf = cand.smartFrame.cropKeyframes[0];
      assert.equal(candFirstKf.time, 0);

      // Convert to timeline project
      const project = convertCandidateToProject(dummy16x9Source, cand, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
        faceDetections: twoPersonDetections,
      });

      const visualSeg = project.visualSegments[0];
      assert.ok(visualSeg.smartFrame, "Timeline visual segment must have smartFrame");
      assert.equal(visualSeg.smartFrame.state, "tracked");
      assert.equal(visualSeg.smartFrame.isFallback, false);
      assert.equal(visualSeg.smartFrame.metadata?.isFallback, false);

      // Keyframes in timeline must be shifted by candidateStartTime
      const timelineKf0 = visualSeg.smartFrame.cropKeyframes[0];
      assert.equal(timelineKf0.time, cand.startTime);
      assert.equal(timelineKf0.state, "tracked");

      // Verify that resolveSmartFrameCropAtTime resolves properly at timeline local time
      const resolvedCropAtLocal = resolveSmartFrameCropAtTime(visualSeg.smartFrame, 2.5);
      assert.ok(resolvedCropAtLocal);
      assert.equal(resolvedCropAtLocal.isFallback, false);
      assert.equal(resolvedCropAtLocal.state, "tracked");
      assert.ok(resolvedCropAtLocal.x < 0.25, `Resolved crop must frame person, got x: ${resolvedCropAtLocal.x}`);
    });
  });

  describe("2. Missing detections handling and fallback honesty", () => {
    it("flags isFallback: true and state: 'fallback' when no face detections exist", () => {
      // Simulate raw uploaded media with no prior face detections
      const candidate = {
        id: "cand-no-detect",
        title: "No Detection Moment",
        startTime: 5,
        endTime: 20,
        duration: 15,
        aspectRatio: "9:16",
        framingMode: "smart-subject",
        cropX: 0.5,
      };

      const project = convertCandidateToProject(dummy16x9Source, candidate, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
        faceDetections: null, // No detections available
      });

      const visualSeg = project.visualSegments[0];
      assert.ok(visualSeg.smartFrame, "Timeline visual segment must have smartFrame fallback record");
      assert.equal(visualSeg.smartFrame.state, "fallback", "Fallback state must be 'fallback', not 'tracked'");
      assert.equal(visualSeg.smartFrame.isFallback, true, "isFallback must be true");
      assert.equal(visualSeg.smartFrame.confidence, 0, "Confidence must be 0 for missing detections fallback");
      assert.equal(visualSeg.smartFrame.metadata?.status, "fallback");
      assert.equal(visualSeg.smartFrame.metadata?.isFallback, true);

      // Inspect resolved crop
      const resolvedCrop = resolveSmartFrameCropAtTime(visualSeg.smartFrame, 7.17);
      assert.ok(resolvedCrop);
      assert.equal(resolvedCrop.isFallback, true);
      assert.equal(resolvedCrop.state, "fallback");
      assert.equal(resolvedCrop.confidence, 0);

      // Verify UI badge condition from App.jsx:
      // smartCropActive = Boolean(rect && !rect.isFallback && rect.state !== 'fallback')
      const rect = smartFrameCropToPixels(resolvedCrop, visualSeg.smartFrame.sourceSize);
      rect.isFallback = Boolean(
        resolvedCrop.isFallback ||
        visualSeg.smartFrame.isFallback ||
        visualSeg.smartFrame.metadata?.status === "fallback" ||
        visualSeg.smartFrame.state === "fallback" ||
        resolvedCrop.state === "fallback"
      );
      rect.state = rect.isFallback ? "fallback" : "tracked";

      const smartCropActive = Boolean(rect && !rect.isFallback && rect.state !== "fallback");
      assert.equal(smartCropActive, false, "Preview must NOT display 'Subject-aware crop' badge when no detections exist!");
    });
  });

  describe("3. Detection Dropout, Scene Cuts, Provenance & Pipeline Propagation", () => {
    it("preserves subject framing across a detection dropout longer than three seconds during a continuous shot", () => {
      // Person on right (x: 0.65-0.85, center: 0.75) detected at t=0 and t=2.
      // Detections drop out from t=2 to t=10 (8 seconds gap > 3.0s).
      const dropoutDetections = [
        {
          time: 0,
          faces: [{ xMin: 0.65, xMax: 0.85, yMin: 0.15, yMax: 0.45, confidence: 0.95, id: "person-right" }],
        },
        {
          time: 2,
          faces: [{ xMin: 0.65, xMax: 0.85, yMin: 0.15, yMax: 0.45, confidence: 0.95, id: "person-right" }],
        },
      ];

      const track = buildDynamicReframingTrack({
        detections: dropoutDetections,
        duration: 10,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: "9:16",
        sceneCuts: [], // Continuous shot
        motion: "smooth",
      });

      assert.ok(track.cropKeyframes.length >= 2);
      // Keyframe at start frames person on right (panFactor > 0.65)
      assert.ok(track.cropKeyframes[0].panFactor > 0.65, `Start panFactor must frame right person, got ${track.cropKeyframes[0].panFactor}`);

      // Resolve at t=5s and t=8s (during the >3s dropout)
      const cropAt5 = resolveSmartFrameCropAtTime(track, 5.0);
      assert.ok(cropAt5);
      assert.ok(cropAt5.panFactor > 0.65, `At 5.0s (dropout), panFactor must stay on subject (> 0.65), got ${cropAt5.panFactor}`);
      assert.notEqual(cropAt5.panFactor, 0.5, "Must NOT collapse to dead center 0.50 during dropout in same shot");

      const cropAt8 = resolveSmartFrameCropAtTime(track, 8.0);
      assert.ok(cropAt8);
      assert.ok(cropAt8.panFactor > 0.65, `At 8.0s (dropout), panFactor must stay on subject (> 0.65), got ${cropAt8.panFactor}`);
    });

    it("resets framing at a genuine scene cut following a dropout rather than blindly coasting", () => {
      // Person on right detected at t=0, t=1.5.
      // Dropout from t=1.5 to t=5.0.
      // Scene cut at t=5.0s. Shot 2 (t=5.0 to 10.0) has NO person detections.
      const cutDetections = [
        {
          time: 0,
          faces: [{ xMin: 0.65, xMax: 0.85, yMin: 0.15, yMax: 0.45, confidence: 0.95, id: "person-right" }],
        },
        {
          time: 1.5,
          faces: [{ xMin: 0.65, xMax: 0.85, yMin: 0.15, yMax: 0.45, confidence: 0.95, id: "person-right" }],
        },
      ];

      const track = buildDynamicReframingTrack({
        detections: cutDetections,
        duration: 10,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: "9:16",
        sceneCuts: [5.0], // Camera angle cut at 5.0s
        motion: "smooth",
      });

      // Before the cut (e.g. t=3.0s), framing is held on the subject
      const preCutCrop = resolveSmartFrameCropAtTime(track, 3.0);
      assert.ok(preCutCrop.panFactor > 0.65, `Pre-cut framing must hold subject, got ${preCutCrop.panFactor}`);

      // After the cut (t=6.0s), because there are no detections in the new shot,
      // it must NOT blindly hold the old camera angle's crop; it falls back to neutral (0.50)
      const postCutCrop = resolveSmartFrameCropAtTime(track, 6.0);
      assert.ok(Math.abs(postCutCrop.panFactor - 0.5) < 0.05, `Post-cut framing without detections must be neutral (~0.50), got ${postCutCrop.panFactor}`);
    });

    it("distinguishes unanalysed centered discovery track from a genuine analyzed track", () => {
      // Unanalysed discovery track: 2 keyframes at center, no detections, no analysis status
      const unanalysedTrack = {
        cropKeyframes: [
          { time: 0, x: 0.3418, y: 0, width: 0.3164, height: 1, panFactor: 0.5, confidence: 1 },
          { time: 15, x: 0.3418, y: 0, width: 0.3164, height: 1, panFactor: 0.5, confidence: 1 },
        ],
      };
      const candidateWithoutAnalysis = {
        id: "c-unanalysed",
        startTime: 0,
        endTime: 15,
        duration: 15,
        smartFrame: unanalysedTrack,
      };

      assert.equal(
        isCandidateSmartFrameFallback(unanalysedTrack, candidateWithoutAnalysis),
        true,
        "Unanalysed 2-keyframe discovery track must be identified as fallback"
      );

      // When converted to project with real face detections provided, it must reframe
      const project = convertCandidateToProject(dummy16x9Source, candidateWithoutAnalysis, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
        faceDetections: twoPersonDetections,
      });

      const visualSeg = project.visualSegments[0];
      assert.equal(visualSeg.smartFrame.isFallback, false);
      assert.equal(visualSeg.smartFrame.state, "tracked");
      // Crop should frame the person on the left (< 0.35)
      assert.ok(visualSeg.cropX < 0.35, `Converted project must reframe from real detections, got cropX ${visualSeg.cropX}`);
    });

    it("preserves valid intentionally centered track as tracked rather than fallback", () => {
      // An intentionally centered track where a person stands in the center (xMin: 0.40, xMax: 0.60)
      // and has genuine detection evidence (detectionsCount: 6, status: "tracked")
      const intentionalCenteredTrack = {
        state: "tracked",
        metadata: {
          status: "tracked",
          detectionsCount: 6,
          isFallback: false,
        },
        cropKeyframes: [
          { time: 0, x: 0.3418, y: 0, width: 0.3164, height: 1, panFactor: 0.5, confidence: 0.95, state: "tracked" },
          { time: 15, x: 0.3418, y: 0, width: 0.3164, height: 1, panFactor: 0.5, confidence: 0.95, state: "tracked" },
        ],
      };
      const candidateWithCenteredSubject = {
        id: "c-centered-person",
        startTime: 0,
        endTime: 15,
        duration: 15,
        trackingStatus: "tracked",
        smartFrame: intentionalCenteredTrack,
      };

      assert.equal(
        isCandidateSmartFrameFallback(intentionalCenteredTrack, candidateWithCenteredSubject),
        false,
        "Intentionally centered track with detection evidence must NOT be classified as fallback"
      );

      const project = convertCandidateToProject(dummy16x9Source, candidateWithCenteredSubject, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
      });

      const visualSeg = project.visualSegments[0];
      assert.equal(visualSeg.smartFrame.isFallback, false);
      assert.equal(visualSeg.smartFrame.state, "tracked");
      assert.equal(visualSeg.cropX, 0.5);
    });

    it("smoothly reacquires subject after a dropout without center collapse", () => {
      // Subject on right at t=0, t=1. Dropout from t=1 to t=7 (6s gap).
      // Subject reacquired at t=7.5 and t=10.
      const reacquisitionDetections = [
        {
          time: 0,
          faces: [{ xMin: 0.65, xMax: 0.85, yMin: 0.15, yMax: 0.45, confidence: 0.95, id: "person-right" }],
        },
        {
          time: 1,
          faces: [{ xMin: 0.65, xMax: 0.85, yMin: 0.15, yMax: 0.45, confidence: 0.95, id: "person-right" }],
        },
        {
          time: 7.5,
          faces: [{ xMin: 0.68, xMax: 0.88, yMin: 0.15, yMax: 0.45, confidence: 0.92, id: "person-right" }],
        },
        {
          time: 10,
          faces: [{ xMin: 0.68, xMax: 0.88, yMin: 0.15, yMax: 0.45, confidence: 0.94, id: "person-right" }],
        },
      ];

      const track = buildDynamicReframingTrack({
        detections: reacquisitionDetections,
        duration: 10,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: "9:16",
        sceneCuts: [],
        motion: "smooth",
      });

      // Sample throughout the 10 seconds:
      for (let t = 0; t <= 10; t += 1.0) {
        const crop = resolveSmartFrameCropAtTime(track, t);
        assert.ok(crop);
        assert.ok(
          crop.panFactor > 0.60,
          `At t=${t}s, panFactor must remain on right subject (> 0.60), got ${crop.panFactor}`
        );
      }
    });

    it("verifies correct propagation of the selected crop into the preview, timeline, and render plan", () => {
      const candidateDetections = [
        {
          time: 5,
          faces: [{ xMin: 0.65, xMax: 0.85, yMin: 0.15, yMax: 0.45, confidence: 0.95, id: "person-right" }],
        },
        {
          time: 10,
          faces: [{ xMin: 0.65, xMax: 0.85, yMin: 0.15, yMax: 0.45, confidence: 0.95, id: "person-right" }],
        },
      ];

      const track = buildDynamicReframingTrack({
        detections: candidateDetections.map((d) => ({ ...d, time: d.time - 5 })),
        duration: 10,
        sourceSize: { width: 1920, height: 1080 },
        targetRatio: "9:16",
      });

      const candidate = {
        id: "c-propagate",
        title: "Propagation Test",
        startTime: 5,
        endTime: 15,
        duration: 10,
        aspectRatio: "9:16",
        framingMode: "smart-subject",
        smartFrame: track,
        trackingStatus: "tracked",
      };

      // 1. Preview panFactor check
      const previewCrop = resolveSmartFrameCropAtTime(candidate.smartFrame, 2.5);
      assert.ok(previewCrop.panFactor > 0.65);
      const previewObjectPosition = `${(previewCrop.panFactor * 100).toFixed(1)}% 50%`;

      // 2. Timeline conversion check
      const project = convertCandidateToProject(dummy16x9Source, candidate, {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
      });
      const visualSeg = project.visualSegments[0];
      assert.ok(visualSeg.cropX > 0.65);
      assert.equal(visualSeg.objectPosition, `${(visualSeg.cropX * 100).toFixed(1)}% 50%`);
      assert.equal(visualSeg.objectPosition, previewObjectPosition);

      // 3. Headless render plan FFmpeg filter check
      const filter = buildReframingFFmpegCropFilter(visualSeg.smartFrame, 720, 1280, 10);
      assert.ok(filter.length > 0, "Render plan filter must not be empty");
      assert.ok(
        filter.includes(`${previewCrop.panFactor.toFixed(4)}`) || filter.includes(`${visualSeg.cropX.toFixed(4)}`),
        `FFmpeg filter must contain calculated panFactor: ${filter}`
      );
    });
  });
});

