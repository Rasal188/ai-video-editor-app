/**
 * @file speaker-aware-reframing.test.js
 * Comprehensive regression tests for Shared Speaker-Aware Reframing.
 *
 * Verifies:
 * 1. Single visible person: stable, sensible portrait crop.
 * 2. Two visible people with reliably identified active speaker: prioritizes the speaker.
 * 3. Multiple people with ambiguous speaker identity: sensible fallback without rapid switching.
 * 4. Speaker change: smooth transition to new speaker where evidence supports it.
 * 5. Temporary face-detection failure / occlusion: stable coasting fallback.
 * 6. Scene cuts: old tracking state does not carry across cuts into the next scene.
 * 7. Portrait and landscape targets: correct crop bounds and aspect ratios.
 * 8. Keyframe timestamps: consistent source-time and timeline-time handling.
 * 9. AI Shorts Studio to Edit in Timeline: crop metadata is strictly preserved.
 * 10. Smart Frame and AI Shorts Studio: shared framing logic produces consistent results.
 * 11. Preview and export: identical intended crop parameters and FFmpeg filter plan.
 * 12. Missing audio / unavailable speaker evidence: safe fallback rather than false active-speaker claim.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  selectPrimaryFace,
  solveFrameCrop,
  calculateTargetCropDimensions,
  buildDynamicReframingTrack,
  SubjectTracker,
  extractSpeechIntervals,
  isSpeechActiveAtTime,
  applyDynamicReframingToCandidate,
  buildReframingFFmpegCropFilter,
} from "../../src/lib/shortsReframing.js";

import {
  buildSmartFrameRecord,
  normalizeSmartFrame,
  resolveSmartFrameCropAtTime,
} from "../../src/lib/smartFrame.js";

import {
  discoverShortCandidates,
  convertCandidateToProject,
} from "../../src/lib/shortsStudio.js";

import {
  resolveFaceAwarePunchInOffset,
} from "../../src/lib/shortsPunchIns.js";

describe("Shared Speaker-Aware Reframing System", () => {
  const SOURCE_1080P = { width: 1920, height: 1080 };
  const CROP_9_16 = calculateTargetCropDimensions(SOURCE_1080P, "9:16");

  // --------------------------------------------------------------------------
  // 1. Single visible person: stable, sensible portrait crop
  // --------------------------------------------------------------------------
  it("1. Single visible person: produces a stable, sensible portrait crop with headroom", () => {
    const singlePerson = {
      id: "speaker-1",
      xMin: 0.70,
      yMin: 0.18,
      xMax: 0.82,
      yMax: 0.42,
      confidence: 0.95,
      isPerson: true,
    };

    const selected = selectPrimaryFace([singlePerson], null, {
      sourceSize: SOURCE_1080P,
      cropDims: CROP_9_16,
    });

    assert.ok(selected, "Primary face selected");
    assert.equal(selected.xMin, 0.70);
    assert.equal(selected.xMax, 0.82);

    const crop = solveFrameCrop(selected, CROP_9_16, { sourceSize: SOURCE_1080P });
    assert.ok(crop.x <= 0.70, "Crop left covers person left");
    assert.ok(crop.x + crop.width >= 0.82, "Crop right covers person right");
    assert.ok(crop.panFactor > 0.65, "panFactor is shifted toward person on right");
    assert.equal(crop.isFallback, false);
    assert.equal(crop.state, "tracked");
  });

  // --------------------------------------------------------------------------
  // 2. Two visible people with reliably identified active speaker
  // --------------------------------------------------------------------------
  it("2. Two visible people: prioritizes the active speaker when visual-audio evidence is reliable", () => {
    // Two people: Person Left at x=0.15, Person Right at x=0.80
    // Neither fits together into a 9:16 portrait crop (span = 0.77 > 0.3164)
    const personLeft = {
      id: "left-speaker",
      label: "person",
      confidence: 0.90,
      xMin: 0.10,
      yMin: 0.20,
      xMax: 0.22,
      yMax: 0.50,
      mouthMotion: 0.85, // active talking mouth motion
      isSpeaking: true,
    };
    const personRight = {
      id: "right-listener",
      label: "person",
      confidence: 0.94, // listener has higher detection confidence or larger size
      xMin: 0.78,
      yMin: 0.18,
      xMax: 0.92,
      yMax: 0.52,
      mouthMotion: 0.02, // listener is silent/stationary
      isSpeaking: false,
    };

    const tracker = new SubjectTracker();
    const detections = [personLeft, personRight];
    const status = tracker.update(detections, 1.0, true, SOURCE_1080P);

    assert.equal(status.activeSpeakerId, "left-speaker", "SubjectTracker identified left person as active speaker");
    assert.ok(status.confidence > 0.5, "Speaker confidence is high");
    assert.equal(status.isAmbiguous, false, "Speaker identity is not ambiguous");

    const selected = selectPrimaryFace(detections, null, {
      sourceSize: SOURCE_1080P,
      cropDims: CROP_9_16,
      activeSpeakerId: status.activeSpeakerId,
      speakerConfidence: status.confidence,
      time: 1.0,
      isSpeechActive: true,
    });

    assert.ok(selected, "Subject selected");
    assert.equal(selected.id, "left-speaker", "selectPrimaryFace prioritized the active speaker");
    assert.ok(selected.xMin < 0.3, "Selected subject is on the left");

    const crop = solveFrameCrop(selected, CROP_9_16, { sourceSize: SOURCE_1080P });
    assert.ok(crop.x <= 0.10, "Crop frames the active speaker on the left");
    assert.ok(crop.panFactor < 0.3, "panFactor is focused on left speaker");
  });

  // --------------------------------------------------------------------------
  // 3. Multiple people with ambiguous speaker identity: sensible fallback without thrashing
  // --------------------------------------------------------------------------
  it("3. Multiple people with ambiguous speaker identity: falls back stably without erratic switching", () => {
    const personA = {
      id: "person-a",
      confidence: 0.91,
      xMin: 0.12,
      yMin: 0.20,
      xMax: 0.24,
      yMax: 0.50,
      mouthMotion: 0.05,
      isSpeaking: false,
    };
    const personB = {
      id: "person-b",
      confidence: 0.90,
      xMin: 0.76,
      yMin: 0.20,
      xMax: 0.88,
      yMax: 0.50,
      mouthMotion: 0.06,
      isSpeaking: false,
    };

    const tracker = new SubjectTracker();
    // Frame 1: speech is false (silence or background music only)
    const statusF1 = tracker.update([personA, personB], 1.0, false, SOURCE_1080P);
    assert.equal(statusF1.isAmbiguous, true, "Speaker is flagged as ambiguous");

    const selectedF1 = selectPrimaryFace([personA, personB], null, {
      sourceSize: SOURCE_1080P,
      cropDims: CROP_9_16,
      activeSpeakerId: statusF1.activeSpeakerId,
      speakerConfidence: statusF1.confidence,
    });
    assert.ok(selectedF1, "A primary person was selected");
    const chosenId = selectedF1.id;

    // Frame 2: personB gets minor confidence bump (0.93 vs 0.91)
    personB.confidence = 0.93;
    const statusF2 = tracker.update([personA, personB], 1.25, false, SOURCE_1080P);
    const selectedF2 = selectPrimaryFace([personA, personB], selectedF1, {
      sourceSize: SOURCE_1080P,
      cropDims: CROP_9_16,
      activeSpeakerId: statusF2.activeSpeakerId,
      speakerConfidence: statusF2.confidence,
    });

    assert.equal(selectedF2.id, chosenId, "Temporal continuity preserves the chosen person without arbitrary thrashing");
  });

  // --------------------------------------------------------------------------
  // 4. Speaker change: smooth transition to new speaker where evidence supports it
  // --------------------------------------------------------------------------
  it("4. Speaker change: smoothly pans camera to new speaker when speaker turns change", () => {
    // 0s to 3s: Person Left is speaking (x=0.15)
    // 3s to 6s: Person Right takes the turn and speaks (x=0.85)
    const detections = [
      { time: 0.0, faces: [
        { id: "p-left", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.9, isSpeaking: true },
        { id: "p-right", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
      ]},
      { time: 1.0, faces: [
        { id: "p-left", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.8, isSpeaking: true },
        { id: "p-right", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
      ]},
      { time: 2.0, faces: [
        { id: "p-left", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.85, isSpeaking: true },
        { id: "p-right", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
      ]},
      // Turn switch to Person Right
      { time: 3.0, faces: [
        { id: "p-left", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
        { id: "p-right", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.95, isSpeaking: true },
      ]},
      { time: 4.0, faces: [
        { id: "p-left", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
        { id: "p-right", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.9, isSpeaking: true },
      ]},
      { time: 5.0, faces: [
        { id: "p-left", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45, mouthMotion: 0.0, isSpeaking: false },
        { id: "p-right", xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45, mouthMotion: 0.85, isSpeaking: true },
      ]},
    ];

    const track = buildDynamicReframingTrack({
      detections,
      duration: 5.0,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
      speechIntervals: [{ start: 0, end: 5.0 }],
    });

    assert.ok(track.cropKeyframes.length >= 4, "Generated keyframes");
    const kf0 = resolveSmartFrameCropAtTime(track, 0.5);
    const kfEnd = resolveSmartFrameCropAtTime(track, 4.5);

    // Initial segment must frame left speaker (x < 0.3)
    assert.ok(kf0.x < 0.3, `Initial crop x (${kf0.x}) frames left speaker`);
    // Later segment must frame right speaker (x > 0.5)
    assert.ok(kfEnd.x > 0.5, `Later crop x (${kfEnd.x}) frames right speaker`);
    // Midpoint should be smoothly interpolated between them without extreme velocity spike
    const kfMid = resolveSmartFrameCropAtTime(track, 3.2);
    assert.ok(kfMid.x >= kf0.x && kfMid.x <= kfEnd.x, "Transition between speakers is smooth and monotonically bounded");
  });

  // --------------------------------------------------------------------------
  // 5. Temporary face-detection failure / occlusion: stable fallback behavior
  // --------------------------------------------------------------------------
  it("5. Temporary face-detection failure: coasts at last known position without snapping to center", () => {
    const detections = [
      { time: 0.0, xMin: 0.78, yMin: 0.20, xMax: 0.88, yMax: 0.45 },
      { time: 1.0, xMin: 0.79, yMin: 0.20, xMax: 0.89, yMax: 0.45 },
      // Lost detection / hand in front of face / turning away
      { time: 2.0, faces: [] },
      { time: 3.0, xMin: 0.78, yMin: 0.20, xMax: 0.88, yMax: 0.45 },
    ];

    const track = buildDynamicReframingTrack({
      detections,
      duration: 3.0,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
    });

    const cropAtLoss = resolveSmartFrameCropAtTime(track, 2.0);
    assert.ok(cropAtLoss.x > 0.5, "Crop stays positioned near right subject during temporary occlusion rather than jumping to 0.5");
  });

  // --------------------------------------------------------------------------
  // 6. Scene cuts: old tracking state does not carry across cuts into the next scene
  // --------------------------------------------------------------------------
  it("6. Scene cuts: tracking state is reset across scene cuts so cross-cut camera panning does not occur", () => {
    // Shot 1 (0s to 3s): subject on the left
    // Scene cut at t = 3.0
    // Shot 2 (3s to 6s): subject on the right
    const detections = [
      { time: 0.0, xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45 },
      { time: 2.5, xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.45 },
      { time: 3.1, xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45 },
      { time: 5.0, xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45 },
    ];

    const track = buildDynamicReframingTrack({
      detections,
      duration: 5.0,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
      sceneCuts: [3.0],
    });

    const hasCutKf = track.cropKeyframes.some((kf) => kf.isCut || kf.cut);
    assert.ok(hasCutKf, "Scene cut keyframe is marked in the track");

    const kfBeforeCut = resolveSmartFrameCropAtTime(track, 2.4);
    const kfAfterCut = resolveSmartFrameCropAtTime(track, 3.2);

    assert.ok(kfBeforeCut.x < 0.25, "Before cut frames left subject");
    assert.ok(kfAfterCut.x > 0.55, "Immediately after cut frames right subject without slow pan");
  });

  // --------------------------------------------------------------------------
  // 7. Portrait and landscape targets: correct crop bounds and aspect ratios
  // --------------------------------------------------------------------------
  it("7. Portrait and landscape targets: maintains valid crop bounds and correct aspect ratios", () => {
    const subject = { xMin: 0.75, yMin: 0.25, xMax: 0.85, yMax: 0.55 };

    const ratios = ["9:16", "1:1", "4:5", "16:9"];
    ratios.forEach((ratio) => {
      const dims = calculateTargetCropDimensions(SOURCE_1080P, ratio);
      const crop = solveFrameCrop(subject, dims, { sourceSize: SOURCE_1080P });

      assert.ok(crop.x >= 0, `crop.x >= 0 for ${ratio}`);
      assert.ok(crop.y >= 0, `crop.y >= 0 for ${ratio}`);
      assert.ok(crop.x + crop.width <= 1.0001, `crop right <= 1 for ${ratio}`);
      assert.ok(crop.y + crop.height <= 1.0001, `crop bottom <= 1 for ${ratio}`);

      if (ratio === "9:16") {
        assert.equal(crop.height, 1.0, "9:16 portrait takes full source height on 16:9 source");
        assert.ok(crop.width < 0.35, "9:16 portrait width is approximately 31.6%");
      } else if (ratio === "16:9") {
        assert.equal(crop.width, 1.0);
        assert.equal(crop.height, 1.0);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 8. Keyframe timestamps: consistent source-time and timeline-time handling
  // --------------------------------------------------------------------------
  it("8. Keyframe timestamps: resolves properly in both local clip time and source time", () => {
    const detections = [
      { time: 0.0, xMin: 0.75, yMin: 0.2, xMax: 0.85, yMax: 0.4 },
      { time: 10.0, xMin: 0.75, yMin: 0.2, xMax: 0.85, yMax: 0.4 },
    ];
    const track = buildDynamicReframingTrack({
      detections,
      duration: 10.0,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
    });

    // Test local segment time resolution
    const localCrop = resolveSmartFrameCropAtTime(track, 5.0);
    assert.ok(localCrop, "Resolved local crop");
    assert.ok(localCrop.x > 0.5, "Crop is on the right");

    // Test when track has sourceSignature.sourceStart = 40.0
    track.sourceSignature = { sourceStart: 40.0, sourceDuration: 10.0 };
    // Querying with absolute timeline time 45.0 (which is local 5.0)
    const sourceCrop = resolveSmartFrameCropAtTime(track, 45.0);
    assert.ok(sourceCrop, "Resolved source crop with sourceStart offset");
    assert.equal(sourceCrop.x, localCrop.x, "Dual-domain time resolution yields identical crop");
  });

  // --------------------------------------------------------------------------
  // 9. AI Shorts Studio to Edit in Timeline: crop metadata is strictly preserved
  // --------------------------------------------------------------------------
  it("9. AI Shorts Studio to Edit in Timeline: preserves reframing track and crop parameters", () => {
    const sourceMedia = {
      id: "video-interview",
      duration: 60,
      width: 1920,
      height: 1080,
      faceDetections: [
        { time: 10, xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45 },
        { time: 15, xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45 },
        { time: 20, xMin: 0.80, yMin: 0.20, xMax: 0.90, yMax: 0.45 },
      ],
    };

    const discovery = discoverShortCandidates({
      sourceMedia,
      transcriptResult: [
        { start: 10, end: 25, text: "Welcome to our podcast interview where we discuss creative workflows." },
      ],
      settings: {
        aspectRatio: "9:16",
        autoReframing: "smart-subject",
      },
    });

    assert.ok(discovery.ok && discovery.candidates.length > 0);
    const candidate = discovery.candidates[0];
    assert.ok(candidate.smartFrame, "Candidate has smartFrame");

    const project = convertCandidateToProject(sourceMedia, candidate, { aspectRatio: "9:16" });
    assert.equal(project.ratioId, "9:16", "Project ratio is preserved as 9:16");
    assert.ok(project.visualSegments.length > 0);

    const segment = project.visualSegments[0];
    assert.ok(segment.smartFrame, "Timeline visual segment preserved smartFrame");
    assert.ok(segment.smartFrame.cropKeyframes.length > 0, "Timeline visual segment preserved cropKeyframes");
    assert.equal(segment.smartFrame.targetRatio, "9:16");
    assert.ok(segment.cropX > 0.6, "panFactor is preserved on right side");
  });

  // --------------------------------------------------------------------------
  // 10. Smart Frame and AI Shorts Studio: shared framing logic consistency
  // --------------------------------------------------------------------------
  it("10. Smart Frame and AI Shorts Studio: shared framing logic produces consistent results", () => {
    const person = {
      box: { xMin: 0.75, yMin: 0.20, xMax: 0.85, yMax: 0.50 },
      label: "person",
      score: 0.92,
    };

    // Smart Frame record
    const sfRecord = buildSmartFrameRecord({
      samples: [{ time: 0, subject: person }],
      sourceSize: SOURCE_1080P,
      targetSize: { width: 1080, height: 1920 },
      targetRatio: "9:16",
      settings: { motion: "smooth" },
    });

    // Shorts Studio reframing track
    const shortsTrack = buildDynamicReframingTrack({
      detections: [{ time: 0, faces: [person.box] }],
      duration: 5,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
    });

    const sfCrop = sfRecord.cropKeyframes[0];
    const shortsCrop = shortsTrack.cropKeyframes[0];

    // Both should frame the subject with equivalent horizontal offset
    assert.ok(Math.abs(sfCrop.x - shortsCrop.x) < 0.08, "Smart Frame and Shorts Studio crop X coordinates are aligned");
    assert.ok(sfCrop.x > 0.5, "Smart Frame crop is on right");
    assert.ok(shortsCrop.x > 0.5, "Shorts Studio crop is on right");
  });

  // --------------------------------------------------------------------------
  // 11. Preview and export: identical intended crop parameters
  // --------------------------------------------------------------------------
  it("11. Preview and export: generates strictly aligned FFmpeg filter and CSS panFactor", () => {
    const person = { xMin: 0.76, yMin: 0.20, xMax: 0.86, yMax: 0.45 };
    const track = buildDynamicReframingTrack({
      detections: [{ time: 0, ...person }],
      duration: 10,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
    });

    const filter = buildReframingFFmpegCropFilter(track, 1080, 1920);
    const panFactor = track.cropKeyframes[0].panFactor;

    assert.ok(filter.includes("crop=1080:1920"), "FFmpeg crop filter uses 1080:1920 output size");
    assert.ok(filter.includes(panFactor.toFixed(4)), "FFmpeg crop filter matches CSS preview panFactor exactly");
  });

  // --------------------------------------------------------------------------
  // 12. Missing audio or unavailable speaker evidence: safe fallback
  // --------------------------------------------------------------------------
  it("12. Missing audio or unavailable speaker evidence: safe fallback rather than false active-speaker claim", () => {
    const faces = [
      { id: "face-left", xMin: 0.15, yMin: 0.2, xMax: 0.25, yMax: 0.45, confidence: 0.9 },
      { id: "face-right", xMin: 0.75, yMin: 0.2, xMax: 0.85, yMax: 0.45, confidence: 0.9 },
    ];

    // No audio speech intervals provided
    const tracker = new SubjectTracker();
    const status = tracker.update(faces, 0.0, false, SOURCE_1080P);

    assert.equal(status.isSpeechActive, false);
    assert.equal(status.isAmbiguous, true);
    assert.equal(status.activeSpeakerId, null, "Does not fabricate active-speaker ID when audio is absent");

    const track = buildDynamicReframingTrack({
      detections: [{ time: 0, faces }],
      duration: 5,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
      speechIntervals: [], // no speech
    });

    assert.equal(track.isFallback, false);
    assert.equal(track.metadata.speakerIdentified, false, "Correctly notes speakerIdentified=false in metadata");
  });

  // --------------------------------------------------------------------------
  // 13. Smart Zoom / Punch-in face anchoring with active speaker
  // --------------------------------------------------------------------------
  it("13. Smart Zoom: anchors punch-in on the active speaker rather than picking irrelevant first face", () => {
    const reframingTrack = {
      isFallback: false,
      detectionCount: 2,
      activeSpeakerId: "speaker-right",
      metadata: { activeSpeakerIds: ["speaker-right"] },
      cropKeyframes: [
        { time: 0, x: 0.65, y: 0, width: 0.3164, height: 1.0, activeSpeakerId: "speaker-right" },
      ],
      sourceSize: SOURCE_1080P,
    };

    // Detection array contains passive listener first, active speaker second
    const faceDetections = [
      {
        time: 1.0,
        faces: [
          { id: "listener-left", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.40 },
          { id: "speaker-right", xMin: 0.75, yMin: 0.20, xMax: 0.85, yMax: 0.40 },
        ],
      },
    ];

    const offset = resolveFaceAwarePunchInOffset({
      reframingTrack,
      time: 1.0,
      scale: 1.25,
      faceDetections,
    });

    assert.ok(offset.faceAnchored, "Punch-in offset is face anchored");
    // Face center in crop: crop.x = 0.65, crop.width = 0.3164. speaker-right center = 0.80.
    // localX = (0.80 - 0.65) / 0.3164 = 0.474 (very close to center 0.5).
    // If it incorrectly picked listener-left (center 0.15), localX would clamp to 0 and punch-in offset would be huge positive.
    assert.ok(Math.abs(offset.x) < 15, `Offset x (${offset.x}) is centered on the framed speaker`);
  });

  // --------------------------------------------------------------------------
  // 14. Shot-level speaker focus: directs crop across multi-person shots
  // --------------------------------------------------------------------------
  it("14. Shot-level speaker focus: directs crop to active speaker across multi-person shots", () => {
    const twoPersonDetections = [
      {
        time: 0.0,
        faces: [
          { id: "interviewer-left", xMin: 0.05, yMin: 0.20, xMax: 0.35, yMax: 0.90, confidence: 0.95 },
          { id: "interviewee-right", xMin: 0.60, yMin: 0.20, xMax: 0.90, yMax: 0.90, confidence: 0.95 },
        ],
      },
      {
        time: 5.0,
        faces: [
          { id: "interviewer-left", xMin: 0.05, yMin: 0.20, xMax: 0.35, yMax: 0.90, confidence: 0.95 },
          { id: "interviewee-right", xMin: 0.60, yMin: 0.20, xMax: 0.90, yMax: 0.90, confidence: 0.95 },
        ],
      },
    ];

    // Build with speakerFocus: 'right' (e.g. from Ollima visual speaker analysis)
    const trackRight = buildDynamicReframingTrack({
      detections: twoPersonDetections,
      duration: 10,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
      speakerFocus: "right",
    });

    const kfRight = trackRight.cropKeyframes[0];
    assert.ok(kfRight.x > 0.50, `Crop x (${kfRight.x}) frames right speaker`);
    assert.ok(kfRight.panFactor > 0.80, `Pan factor (${kfRight.panFactor}) is on right side`);

    // Build with speakerFocusMap switching from left to right at t = 3.0
    const trackSwitch = buildDynamicReframingTrack({
      detections: [
        {
          time: 1.0,
          faces: [
            { id: "person-a", xMin: 0.05, yMin: 0.20, xMax: 0.35, yMax: 0.90, confidence: 0.95 },
            { id: "person-b", xMin: 0.60, yMin: 0.20, xMax: 0.90, yMax: 0.90, confidence: 0.95 },
          ],
        },
        {
          time: 4.0,
          faces: [
            { id: "person-a", xMin: 0.05, yMin: 0.20, xMax: 0.35, yMax: 0.90, confidence: 0.95 },
            { id: "person-b", xMin: 0.60, yMin: 0.20, xMax: 0.90, yMax: 0.90, confidence: 0.95 },
          ],
        },
      ],
      duration: 6,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
      speakerFocusMap: [
        { start: 0, end: 2.5, focus: "left" },
        { start: 2.5, end: 6.0, focus: "right" },
      ],
    });

    const cropAt1 = resolveSmartFrameCropAtTime(trackSwitch, 1.0);
    const cropAt4 = resolveSmartFrameCropAtTime(trackSwitch, 4.0);
    assert.ok(cropAt1.x < 0.20, `At 1s, crop x (${cropAt1.x}) follows left speaker`);
    assert.ok(cropAt4.x > 0.50, `At 4s, crop x (${cropAt4.x}) follows right speaker`);
  });

  // --------------------------------------------------------------------------
  // 15. Scene cut boundary precision: old crop terminates at cut, new crop begins at cut
  // --------------------------------------------------------------------------
  it("15. Scene cut boundary precision: old crop does not persist across cuts between sparse detections", () => {
    // Shot 1 (Wide): Subject on the right (x ~ 0.78). Detection at t = 24.0, 28.0
    // Scene cut at t = 28.3s into Shot 2 (Close-up, centered at x ~ 0.50)
    // Next detection sample is delayed at t = 32.0s
    const detections = [
      {
        time: 24.0,
        faces: [{ id: "susad", xMin: 0.585, yMin: 0.164, xMax: 0.987, yMax: 0.957, confidence: 0.99 }],
      },
      {
        time: 28.0,
        faces: [{ id: "susad", xMin: 0.590, yMin: 0.165, xMax: 0.985, yMax: 0.960, confidence: 0.99 }],
      },
      {
        time: 32.0,
        faces: [{ id: "susad", xMin: 0.225, yMin: 0.144, xMax: 0.744, yMax: 0.963, confidence: 0.96 }],
      },
    ];

    const track = buildDynamicReframingTrack({
      detections,
      duration: 36,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
      sceneCuts: [28.3],
    });

    // 1. Verify keyframe structure around the cut
    const holdKf = track.cropKeyframes.find((kf) => Math.abs(kf.time - 28.27) < 0.02);
    assert.ok(holdKf, "Hold keyframe placed 30ms before actual cut (t=28.27s)");
    assert.ok(holdKf.x > 0.60, `Hold keyframe x (${holdKf.x}) preserves Shot 1 right-side framing`);

    const cutKf = track.cropKeyframes.find((kf) => Math.abs(kf.time - 28.3) < 0.01);
    assert.ok(cutKf, "Cut keyframe placed exactly at scene cut timestamp (t=28.3s)");
    assert.equal(Boolean(cutKf.cut || cutKf.isCut), true, "Cut flag set on cut keyframe");
    assert.ok(cutKf.x < 0.40, `Cut keyframe x (${cutKf.x}) immediately applies Shot 2 centered framing`);
    assert.ok(cutKf.panFactor < 0.60, `Cut keyframe panFactor (${cutKf.panFactor}) is centered`);

    // 2. Verify resolved crop at critical timestamps
    // Before cut: still on Shot 1 (right-aligned)
    const cropBefore = resolveSmartFrameCropAtTime(track, 28.2);
    assert.ok(cropBefore.x > 0.60, `Crop at 28.2s (${cropBefore.x}) frames Shot 1`);

    // Immediately after cut: switches immediately to Shot 2 (centered)
    const cropImmediatelyAfter = resolveSmartFrameCropAtTime(track, 28.35);
    assert.ok(cropImmediatelyAfter.x < 0.40, `Crop at 28.35s (${cropImmediatelyAfter.x}) is centered on Shot 2`);

    // At previously problematic 30.2s and 30.8s: MUST be centered on Shot 2, NOT right-aligned
    const cropAt302 = resolveSmartFrameCropAtTime(track, 30.2);
    const cropAt308 = resolveSmartFrameCropAtTime(track, 30.8);
    assert.ok(cropAt302.x < 0.40, `Crop at 30.2s (${cropAt302.x}) is centered on Shot 2`);
    assert.ok(cropAt308.x < 0.40, `Crop at 30.8s (${cropAt308.x}) is centered on Shot 2`);
    assert.ok(cropAt302.panFactor < 0.60, `PanFactor at 30.2s (${cropAt302.panFactor}) does NOT bleed old 0.92 panFactor`);
    assert.ok(cropAt308.panFactor < 0.60, `PanFactor at 30.8s (${cropAt308.panFactor}) does NOT bleed old 0.92 panFactor`);

    // 3. Test missing / delayed detection right after a cut:
    // When the first sample after a cut has no face, forward-scan uses the next sample in the shot
    // rather than incorrectly carrying the previous shot's crop across the cut.
    const trackMissingDetection = buildDynamicReframingTrack({
      detections: [
        { time: 2.0, faces: [{ id: "p-left", xMin: 0.10, yMin: 0.20, xMax: 0.20, yMax: 0.50 }] },
        { time: 5.5, faces: [] }, // temporary occlusion right after cut
        { time: 7.0, faces: [{ id: "p-center", xMin: 0.40, yMin: 0.20, xMax: 0.60, yMax: 0.50 }] },
      ],
      duration: 10,
      sourceSize: SOURCE_1080P,
      targetRatio: "9:16",
      sceneCuts: [5.0],
    });

    const cropAfterCutMissing = resolveSmartFrameCropAtTime(trackMissingDetection, 5.2);
    assert.ok(cropAfterCutMissing.x > 0.20, `Crop after cut (${cropAfterCutMissing.x}) does NOT bleed previous shot's left position (x=0)`);
  });
});
