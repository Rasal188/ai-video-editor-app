import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    isEditorInteractiveTarget,
    isEditorShortcutBlockedByModal,
    isEditorTextEntryTarget,
} from "../../src/lib/editorShortcuts.js";

class FakeElement {
    constructor(selectorToken = "") {
        this.selectorToken = selectorToken;
    }

    closest(selector) {
        return selector.includes(this.selectorToken) ? this : null;
    }
}

describe("editor shortcut context guards", () => {
    const originalElement = globalThis.Element;
    const originalDocument = globalThis.document;

    before(() => {
        globalThis.Element = FakeElement;
    });

    after(() => {
        if (originalElement === undefined) delete globalThis.Element;
        else globalThis.Element = originalElement;

        if (originalDocument === undefined) delete globalThis.document;
        else globalThis.document = originalDocument;
    });

    it("blocks text entry and editable media-control targets", () => {
        for (const selectorToken of [
            "input",
            "textarea",
            "select",
            "[contenteditable='true']",
            "audio[controls]",
            "video[controls]",
        ]) {
            assert.equal(
                isEditorTextEntryTarget(new FakeElement(selectorToken)),
                true,
                `${selectorToken} should block global editor shortcuts`,
            );
        }

        assert.equal(isEditorTextEntryTarget(new FakeElement("canvas")), false);
        assert.equal(isEditorTextEntryTarget(null), false);
    });

    it("blocks buttons, links, menus, and sliders", () => {
        for (const selectorToken of [
            "button",
            "a",
            "[role='button']",
            "[role='menuitem']",
            "[role='menuitemradio']",
            "[role='slider']",
        ]) {
            assert.equal(
                isEditorInteractiveTarget(new FakeElement(selectorToken)),
                true,
                `${selectorToken} should block global editor shortcuts`,
            );
        }

        assert.equal(isEditorInteractiveTarget(new FakeElement("canvas")), false);
        assert.equal(isEditorInteractiveTarget(null), false);
    });

    it("blocks ordinary dialogs while allowing the focus-preview dialog", () => {
        globalThis.document = {
            querySelector: () => null,
        };
        assert.equal(isEditorShortcutBlockedByModal(), false);

        globalThis.document = {
            querySelector: () => ({ matches: () => false }),
        };
        assert.equal(isEditorShortcutBlockedByModal(), true);

        globalThis.document = {
            querySelector: () => ({
                matches: (selector) => selector === ".preview-stage.is-focus-preview",
            }),
        };
        assert.equal(isEditorShortcutBlockedByModal(), false);
    });
});
