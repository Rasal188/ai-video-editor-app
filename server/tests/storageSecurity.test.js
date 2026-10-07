import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { config } from "../config.js";
import {
  validateStoragePath,
  resolveSafeStoragePath,
} from "../services/storage/storageSecurity.js";
import { BadRequestError } from "../services/errors.js";

describe("Storage Path Security", () => {
  const storageRoot = resolve(config.storage.localDirectory);

  describe("validateStoragePath", () => {
    it("should accept valid relative paths within storage root", () => {
      const validPaths = [
        "projects/project-1.timeline",
        "renders/job-123.mp4",
        "assets/video-sample.mp4",
        "storage/projects/project-trimmed.timeline",
        "storage/renders/render-456.mp4",
      ];

      for (const p of validPaths) {
        assert.doesNotThrow(() => {
          const validated = validateStoragePath(p);
          assert.equal(validated, p);
        }, `Expected ${p} to be valid`);
      }
    });

    it("should reject directory traversal with ../", () => {
      const traversalPaths = [
        "../package.json",
        "../../etc/passwd",
        "projects/../../server/config.js",
        "storage/../../package.json",
        "projects/../../../Windows/System32",
      ];

      for (const p of traversalPaths) {
        assert.throws(
          () => validateStoragePath(p),
          (err) => err instanceof BadRequestError && err.code === "INVALID_STORAGE_PATH",
          `Expected ${p} to be rejected for traversal`
        );
      }
    });

    it("should reject POSIX absolute paths", () => {
      const absolutePaths = [
        "/etc/passwd",
        "/var/log/syslog",
        "/storage/projects/1.timeline",
        "/root",
      ];

      for (const p of absolutePaths) {
        assert.throws(
          () => validateStoragePath(p),
          (err) => err instanceof BadRequestError && err.code === "INVALID_STORAGE_PATH",
          `Expected ${p} to be rejected as absolute path`
        );
      }
    });

    it("should reject Windows-style absolute paths and drive specifiers", () => {
      const windowsPaths = [
        "C:\\Windows\\System32\\cmd.exe",
        "C:/Users/test/file.txt",
        "D:\\data\\video.mp4",
        "c:secrets.txt",
        "\\Windows\\System32",
        "\\\\server\\share\\file.txt",
      ];

      for (const p of windowsPaths) {
        assert.throws(
          () => validateStoragePath(p),
          (err) => err instanceof BadRequestError && err.code === "INVALID_STORAGE_PATH",
          `Expected ${p} to be rejected as Windows path`
        );
      }
    });

    it("should reject paths attempting to escape storage root", () => {
      const outsidePaths = [
        "storage/../.env",
        "storage/../server/index.js",
        "projects/..",
      ];

      for (const p of outsidePaths) {
        assert.throws(
          () => validateStoragePath(p),
          (err) => err instanceof BadRequestError && err.code === "INVALID_STORAGE_PATH",
          `Expected ${p} to be rejected as outside storage root`
        );
      }
    });

    it("should reject null bytes and empty/invalid input", () => {
      const invalidInputs = [
        "projects/file.timeline\0.txt",
        "",
        "   ",
        null,
        undefined,
        123,
      ];

      for (const p of invalidInputs) {
        assert.throws(
          () => validateStoragePath(p),
          (err) => err instanceof BadRequestError && err.code === "INVALID_STORAGE_PATH",
          `Expected ${p} to be rejected as invalid input`
        );
      }
    });
  });

  describe("resolveSafeStoragePath", () => {
    it("should safely resolve paths inside the configured storage root", () => {
      const path1 = resolveSafeStoragePath("projects/test.timeline");
      assert.ok(path1.startsWith(storageRoot + sep) || path1 === storageRoot);
      assert.ok(path1.endsWith("test.timeline"));

      const path2 = resolveSafeStoragePath("storage/renders/sample.mp4");
      assert.ok(path2.startsWith(storageRoot + sep));
      assert.ok(path2.endsWith("sample.mp4"));
    });

    it("should throw for malicious traversal inputs", () => {
      assert.throws(() => resolveSafeStoragePath("../../etc/passwd"));
      assert.throws(() => resolveSafeStoragePath("C:\\Windows\\cmd.exe"));
    });
  });
});
