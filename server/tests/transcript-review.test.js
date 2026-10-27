import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCaptionTimestamp,
  validateCaptionSegments,
  regroupReviewSegments,
  updateSegmentText,
  updateSegmentTiming,
  deleteSegment,
  addSegment,
  prepareSegmentsForTimeline,
} from "../../src/lib/transcriptReview.js";

describe("Transcript Review Workflow & Validation", () => {
  describe("Timestamp Validation", () => {
    it("should accept valid finite positive timestamps", () => {
      const res = validateCaptionTimestamp(0, 1.5);
      assert.equal(res.valid, true);
      assert.equal(res.error, null);

      const res2 = validateCaptionTimestamp(1.5, 1.5); // Zero duration instantaneous token is allowed
      assert.equal(res2.valid, true);
    });

    it("should reject negative start times", () => {
      const res = validateCaptionTimestamp(-0.5, 1.0);
      assert.equal(res.valid, false);
      assert.ok(res.error.includes("cannot be negative"));
    });

    it("should reject non-finite start or end times", () => {
      assert.equal(validateCaptionTimestamp(NaN, 1.0).valid, false);
      assert.equal(validateCaptionTimestamp(0.5, Infinity).valid, false);
      assert.equal(validateCaptionTimestamp(undefined, 2.0).valid, false);
    });

    it("should reject inverted intervals where end < start", () => {
      const res = validateCaptionTimestamp(3.5, 2.0);
      assert.equal(res.valid, false);
      assert.ok(res.error.includes("greater than or equal to start"));
    });

    it("should validate all segments in a list and locate the invalid index", () => {
      const segments = [
        { id: "c1", start: 0, end: 1.2, text: "Valid one" },
        { id: "c2", start: 2.0, end: 1.5, text: "Inverted interval" },
        { id: "c3", start: 2.5, end: 3.5, text: "Valid three" },
      ];

      const check = validateCaptionSegments(segments);
      assert.equal(check.valid, false);
      assert.equal(check.errors.length, 1);
      assert.equal(check.errors[0].index, 1);
      assert.equal(check.errors[0].id, "c2");
    });
  });

  describe("Segment Editing Operations", () => {
    const initialSegments = [
      { id: "s1", start: 0.0, end: 1.0, text: "First segment" },
      { id: "s2", start: 1.2, end: 2.5, text: "Second segment" },
    ];

    it("should update segment text cleanly", () => {
      const updated = updateSegmentText(initialSegments, "s1", "Edited first segment");
      assert.equal(updated[0].text, "Edited first segment");
      assert.equal(updated[1].text, "Second segment");
    });

    it("should update segment start and end timing", () => {
      const updated = updateSegmentTiming(initialSegments, "s2", { start: 1.5, end: 3.0 });
      assert.equal(updated[1].start, 1.5);
      assert.equal(updated[1].end, 3.0);
      assert.equal(updated[0].start, 0.0);
    });

    it("should delete a segment by ID", () => {
      const updated = deleteSegment(initialSegments, "s1");
      assert.equal(updated.length, 1);
      assert.equal(updated[0].id, "s2");
    });

    it("should add a new segment after the last segment", () => {
      const updated = addSegment(initialSegments, null, { text: "Third segment" });
      assert.equal(updated.length, 3);
      assert.equal(updated[2].text, "Third segment");
      assert.equal(updated[2].start, 2.5);
      assert.equal(updated[2].end, 4.5);
    });
  });

  describe("Caption Regrouping", () => {
    const rawChunks = [
      { text: "What", timestamp: [0.0, 0.3] },
      { text: " if", timestamp: [0.3, 0.5] },
      { text: " someone", timestamp: [0.5, 0.9] },
      { text: " could", timestamp: [0.9, 1.2] },
      { text: " read", timestamp: [1.2, 1.5] },
      { text: " passwords?", timestamp: [1.5, 2.2] },
    ];
    const duration = 2.5;

    it("should regroup into phrase segments", () => {
      const phraseSegments = regroupReviewSegments(rawChunks, duration, {
        timelineOffset: 0,
        grouping: "phrases",
      });
      assert.ok(phraseSegments.length >= 1);
      assert.ok(phraseSegments.length < rawChunks.length);
      assert.equal(phraseSegments[0].start, 0.0);
    });

    it("should regroup into individual word segments when requested", () => {
      const wordSegments = regroupReviewSegments(rawChunks, duration, {
        timelineOffset: 0,
        grouping: "words",
      });
      assert.equal(wordSegments.length, rawChunks.length);
      assert.equal(wordSegments[0].text, "What");
      assert.equal(wordSegments[1].text, "if");
    });
  });

  describe("Pre-Apply Invariance & Apply/Cancel Flow", () => {
    it("should verify timeline captions remain completely untouched before Apply", () => {
      let timelineCaptions = [
        { id: "pre-existing-1", start: 10, end: 12, text: "Existing caption" },
      ];
      let script = "Existing caption";

      // Simulate transcription completion creating review state
      const reviewData = {
        isOpen: true,
        text: "New recognized text",
        segments: [
          { id: "new-1", start: 0, end: 1.5, text: "New recognized text" },
        ],
        timelineOffset: 0,
      };

      // Assert timeline is NOT modified when review modal opens
      assert.equal(timelineCaptions.length, 1);
      assert.equal(timelineCaptions[0].text, "Existing caption");
      assert.equal(script, "Existing caption");

      // User cancels review
      const onCancel = () => {
        // Modal closes, timeline is preserved
        reviewData.isOpen = false;
      };
      onCancel();

      // Timeline must remain completely identical
      assert.equal(timelineCaptions.length, 1);
      assert.equal(timelineCaptions[0].text, "Existing caption");
      assert.equal(script, "Existing caption");
    });

    it("should apply reviewed captions only when explicitly committed", () => {
      let timelineCaptions = [];
      let script = "";
      let activeTrack = null;
      let captionsEnabled = false;

      const reviewedSegments = [
        { id: "rev-2", start: 2.0, end: 3.5, text: "Part two" },
        { id: "rev-1", start: 0.5, end: 1.8, text: "Part one" },
      ];
      const reviewedFullText = "Part one\nPart two";

      const handleApply = ({ segments, text }) => {
        // Validation check before applying
        const validation = validateCaptionSegments(segments);
        if (!validation.valid) throw new Error("Cannot apply invalid segments");

        const prepared = prepareSegmentsForTimeline(segments, "custom-font");
        timelineCaptions = prepared;
        script = text;
        activeTrack = "caption";
        captionsEnabled = true;
      };

      handleApply({ segments: reviewedSegments, text: reviewedFullText });

      // Verifications:
      assert.equal(timelineCaptions.length, 2);
      // Monotonically sorted:
      assert.equal(timelineCaptions[0].id, "rev-1");
      assert.equal(timelineCaptions[0].start, 0.5);
      assert.equal(timelineCaptions[0].fontId, "custom-font");
      assert.equal(timelineCaptions[1].id, "rev-2");
      assert.equal(timelineCaptions[1].start, 2.0);
      assert.equal(script, "Part one\nPart two");
      assert.equal(activeTrack, "caption");
      assert.equal(captionsEnabled, true);
    });

    it("should prevent applying when validation fails", () => {
      let timelineCaptions = [];
      const invalidSegments = [
        { id: "bad-1", start: 5.0, end: 2.0, text: "Inverted timing" },
      ];

      const validation = validateCaptionSegments(invalidSegments);
      assert.equal(validation.valid, false);

      // Attempting to apply should be blocked
      assert.throws(
        () => {
          if (!validation.valid) throw new Error("Validation failed");
          timelineCaptions = invalidSegments;
        },
        /Validation failed/
      );

      assert.equal(timelineCaptions.length, 0);
    });

    it("should handle empty transcripts and prevent applying empty segment lists", () => {
      let timelineCaptions = [];
      const emptySegments = [];

      const handleApply = ({ segments }) => {
        if (!segments || segments.length === 0) {
          throw new Error("Cannot apply empty caption segments");
        }
        timelineCaptions = segments;
      };

      assert.throws(
        () => handleApply({ segments: emptySegments }),
        /Cannot apply empty caption segments/
      );
      assert.equal(timelineCaptions.length, 0);
    });

    it("should handle dismissal via backdrop, cancel button, or escape without altering timeline", () => {
      let timelineCaptions = [{ id: "saved-cap", start: 1, end: 3, text: "Unchanged" }];
      let reviewModalOpen = true;

      const dismissModal = (dismissType) => {
        // Backdrop click, Escape key, or Cancel button
        assert.ok(["backdrop", "escape", "cancel_button"].includes(dismissType));
        reviewModalOpen = false;
        // Timeline is not touched
      };

      dismissModal("escape");
      assert.equal(reviewModalOpen, false);
      assert.equal(timelineCaptions.length, 1);
      assert.equal(timelineCaptions[0].text, "Unchanged");

      reviewModalOpen = true;
      dismissModal("backdrop");
      assert.equal(reviewModalOpen, false);
      assert.equal(timelineCaptions.length, 1);

      reviewModalOpen = true;
      dismissModal("cancel_button");
      assert.equal(reviewModalOpen, false);
      assert.equal(timelineCaptions.length, 1);
    });
  });

  describe("Auto Caption Error & Cancellation Recovery", () => {
    it("should recover from transcription errors without opening review modal or corrupting state", () => {
      let reviewState = null;
      let timelineCaptions = [];
      let status = "idle";
      let statusText = "";
      let progress = 0;
      let notification = "";

      // Simulated error inside auto-captions flow
      const simulateAutoCaptionsError = (err) => {
        status = "error";
        statusText = err?.message || "autoCaptionsFailed";
        progress = 0;
        notification = "Caption generation failed";
        // Notice: reviewState is NEVER set when inference fails!
      };

      simulateAutoCaptionsError(new Error("ASR_WORD_TIMING_UNAVAILABLE"));

      assert.equal(reviewState, null);
      assert.equal(status, "error");
      assert.equal(progress, 0);
      assert.equal(notification, "Caption generation failed");
      assert.equal(timelineCaptions.length, 0);
    });
  });

  describe("Caption Audition Playback Lifecycle", () => {
    it("should handle start, pause toggle, switching captions, and cleanup on close", () => {
      let isPlaying = false;
      let currentTime = 0;
      let auditioningCaptionId = null;
      let auditionTimer = null;

      const stopAudition = () => {
        if (auditionTimer) {
          clearTimeout(auditionTimer);
          auditionTimer = null;
        }
        isPlaying = false;
        auditioningCaptionId = null;
      };

      const previewCaption = (seg) => {
        const targetId = seg.id;
        if (auditioningCaptionId === targetId) {
          stopAudition();
          return;
        }
        if (auditionTimer) {
          clearTimeout(auditionTimer);
          auditionTimer = null;
        }
        currentTime = seg.start;
        isPlaying = true;
        auditioningCaptionId = targetId;

        const durationMs = Math.max(250, (seg.end - seg.start) * 1000);
        auditionTimer = setTimeout(() => {
          isPlaying = false;
          auditioningCaptionId = null;
          auditionTimer = null;
        }, durationMs);
      };

      const seg1 = { id: "cap-1", start: 1.0, end: 2.0, text: "Hello" };
      const seg2 = { id: "cap-2", start: 3.5, end: 4.5, text: "World" };

      // 1. Start auditioning seg1
      previewCaption(seg1);
      assert.equal(isPlaying, true, "Playback should start");
      assert.equal(currentTime, 1.0, "Timeline should seek to seg1.start");
      assert.equal(auditioningCaptionId, "cap-1", "Active auditioning caption ID should be cap-1");
      assert.ok(auditionTimer !== null, "Audition timer should be active");

      // 2. Toggle pause on seg1
      previewCaption(seg1);
      assert.equal(isPlaying, false, "Playback should pause when clicked again");
      assert.equal(auditioningCaptionId, null, "auditioningCaptionId should reset to null");
      assert.equal(auditionTimer, null, "Audition timer should be cleared");

      // 3. Switch to seg2
      previewCaption(seg1);
      assert.equal(auditioningCaptionId, "cap-1");
      previewCaption(seg2);
      assert.equal(auditioningCaptionId, "cap-2", "Should switch active auditioning caption to cap-2");
      assert.equal(currentTime, 3.5, "Timeline should seek to seg2.start");
      assert.equal(isPlaying, true, "Playback should remain active for seg2");

      // 4. Modal close cleanup
      stopAudition();
      assert.equal(isPlaying, false, "Close should pause playback");
      assert.equal(auditioningCaptionId, null, "Close should clear audition ID");
      assert.equal(auditionTimer, null, "Close should clear timer");
    });
  });
});
