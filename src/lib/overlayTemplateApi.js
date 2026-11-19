import { serializeOverlayTemplateForApi } from "./shortsOverlayTemplates.js";

const TEMPLATE_API_PATH = "/api/overlay-templates";

export class OverlayTemplateApiError extends Error {
    constructor(message, { code = "OVERLAY_TEMPLATE_API_ERROR", status = 0 } = {}) {
        super(message);
        this.name = "OverlayTemplateApiError";
        this.code = code;
        this.status = status;
    }
}

function requireFetch(fetchImpl) {
    if (typeof fetchImpl !== "function") {
        throw new OverlayTemplateApiError("Template API is unavailable.", {
            code: "OVERLAY_TEMPLATE_FETCH_UNAVAILABLE",
        });
    }
    return fetchImpl;
}

async function requestOverlayTemplateApi({
    url,
    fetchImpl,
    options = {},
    failureCode,
    failureMessage,
    isValidBody,
}) {
    const request = requireFetch(fetchImpl);
    let response;

    try {
        response = await request(url, {
            credentials: "include",
            ...options,
        });
    } catch (error) {
        throw new OverlayTemplateApiError(error?.message || failureMessage, {
            code: failureCode,
        });
    }

    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok || !isValidBody(body)) {
        throw new OverlayTemplateApiError(body?.message || failureMessage, {
            code: body?.code || failureCode,
            status: response.status,
        });
    }

    return body;
}

function jsonOptions(method, payload) {
    return {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    };
}

export async function createOverlayTemplateRequest(template, { fetchImpl = globalThis.fetch } = {}) {
    const body = await requestOverlayTemplateApi({
        url: TEMPLATE_API_PATH,
        fetchImpl,
        options: jsonOptions("POST", serializeOverlayTemplateForApi(template)),
        failureCode: "OVERLAY_TEMPLATE_CREATE_FAILED",
        failureMessage: "Template could not be saved.",
        isValidBody: (value) => Boolean(value.template),
    });
    return body.template;
}

export async function listOverlayTemplatesRequest({
    search = "",
    limit = 50,
    offset = 0,
    fetchImpl = globalThis.fetch,
} = {}) {
    const params = new URLSearchParams();
    if (String(search).trim()) params.set("search", String(search).trim());
    if (limit !== undefined && limit !== null) params.set("limit", String(limit));
    if (offset !== undefined && offset !== null) params.set("offset", String(offset));
    const query = params.toString();
    const body = await requestOverlayTemplateApi({
        url: query ? `${TEMPLATE_API_PATH}?${query}` : TEMPLATE_API_PATH,
        fetchImpl,
        failureCode: "OVERLAY_TEMPLATE_LIST_FAILED",
        failureMessage: "Templates could not be loaded.",
        isValidBody: (value) => Array.isArray(value.templates),
    });
    return body.templates;
}

export async function getOverlayTemplateRequest(templateId, { fetchImpl = globalThis.fetch } = {}) {
    const body = await requestOverlayTemplateApi({
        url: `${TEMPLATE_API_PATH}/${encodeURIComponent(templateId)}`,
        fetchImpl,
        failureCode: "OVERLAY_TEMPLATE_GET_FAILED",
        failureMessage: "Template details could not be loaded.",
        isValidBody: (value) => Boolean(value.template),
    });
    return body.template;
}

export async function updateOverlayTemplateRequest(templateId, updates, { fetchImpl = globalThis.fetch } = {}) {
    const body = await requestOverlayTemplateApi({
        url: `${TEMPLATE_API_PATH}/${encodeURIComponent(templateId)}`,
        fetchImpl,
        options: jsonOptions("PATCH", updates || {}),
        failureCode: "OVERLAY_TEMPLATE_UPDATE_FAILED",
        failureMessage: "Template could not be updated.",
        isValidBody: (value) => Boolean(value.template),
    });
    return body.template;
}

export async function duplicateOverlayTemplateRequest(templateId, { name, fetchImpl = globalThis.fetch } = {}) {
    const payload = typeof name === "string" && name.trim() ? { name: name.trim() } : {};
    const body = await requestOverlayTemplateApi({
        url: `${TEMPLATE_API_PATH}/${encodeURIComponent(templateId)}/duplicate`,
        fetchImpl,
        options: jsonOptions("POST", payload),
        failureCode: "OVERLAY_TEMPLATE_DUPLICATE_FAILED",
        failureMessage: "Template could not be duplicated.",
        isValidBody: (value) => Boolean(value.template),
    });
    return body.template;
}

export async function deleteOverlayTemplateRequest(templateId, { fetchImpl = globalThis.fetch } = {}) {
    const body = await requestOverlayTemplateApi({
        url: `${TEMPLATE_API_PATH}/${encodeURIComponent(templateId)}`,
        fetchImpl,
        options: { method: "DELETE" },
        failureCode: "OVERLAY_TEMPLATE_DELETE_FAILED",
        failureMessage: "Template could not be deleted.",
        isValidBody: (value) => typeof value.id === "string" && value.id.length > 0,
    });
    return { id: body.id, message: body.message || "" };
}
