import { serializeOverlayTemplateForApi } from "./shortsOverlayTemplates.js";

export class OverlayTemplateApiError extends Error {
    constructor(message, { code = "OVERLAY_TEMPLATE_API_ERROR", status = 0 } = {}) {
        super(message);
        this.name = "OverlayTemplateApiError";
        this.code = code;
        this.status = status;
    }
}

export async function createOverlayTemplateRequest(template, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
        throw new OverlayTemplateApiError("Template API is unavailable.", {
            code: "OVERLAY_TEMPLATE_FETCH_UNAVAILABLE",
        });
    }

    const response = await fetchImpl("/api/overlay-templates", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(serializeOverlayTemplateForApi(template)),
    });
    const body = await response.json().catch(() => null);

    if (!response.ok || !body?.ok || !body?.template) {
        throw new OverlayTemplateApiError(
            body?.message || "Template could not be saved.",
            {
                code: body?.code || "OVERLAY_TEMPLATE_CREATE_FAILED",
                status: response.status,
            },
        );
    }

    return body.template;
}
