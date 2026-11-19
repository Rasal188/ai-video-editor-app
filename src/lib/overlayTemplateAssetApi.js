const ASSET_API_PATH = "/api/assets";
const SUPPORTED_IMAGE_MIME_TYPES = Object.freeze([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/svg+xml",
]);
const SUPPORTED_IMAGE_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "webp", "svg"]);

export class OverlayTemplateAssetApiError extends Error {
    constructor(message, { code = "OVERLAY_TEMPLATE_ASSET_API_ERROR", status = 0 } = {}) {
        super(message);
        this.name = "OverlayTemplateAssetApiError";
        this.code = code;
        this.status = status;
    }
}

function normalizeMimeType(value = "") {
    return String(value).trim().toLowerCase().split(";", 1)[0];
}

function extensionForFilename(filename = "") {
    return String(filename).trim().toLowerCase().split(".").pop() || "";
}

function uploadMimeType(file) {
    const declared = normalizeMimeType(file?.type);
    if (declared) return declared;
    const inferred = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        svg: "image/svg+xml",
    }[extensionForFilename(file?.name)];
    return inferred || "application/octet-stream";
}

export function isSupportedOverlayTemplateImage(file) {
    if (!file) return false;
    const mimeType = normalizeMimeType(file.type);
    const extension = extensionForFilename(file.name);
    return SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType)
        || (!mimeType && SUPPORTED_IMAGE_EXTENSIONS.includes(extension));
}

function normalizeAsset(asset = {}) {
    const id = String(asset.id || asset.assetId || "");
    const metadata = asset.metadata && typeof asset.metadata === "object"
        ? asset.metadata
        : {};
    const mimeType = normalizeMimeType(asset.mime_type || asset.mimeType);
    return {
        id,
        assetId: id,
        type: "image",
        kind: "image",
        mediaKind: "image",
        name: asset.filename || asset.name || "Template image",
        filename: asset.filename || asset.name || "",
        mimeType,
        width: Math.max(1, Math.round(Number(metadata.width || asset.width) || 1)),
        height: Math.max(1, Math.round(Number(metadata.height || asset.height) || 1)),
        checksum: asset.sha256 || asset.checksum || "",
        sha256: asset.sha256 || asset.checksum || "",
        src: `${ASSET_API_PATH}/${encodeURIComponent(id)}/content`,
        thumbnail: `${ASSET_API_PATH}/${encodeURIComponent(id)}/content`,
        provider: "Template Studio",
        storageScope: metadata.scope || "",
        persistent: true,
    };
}

async function readJsonResponse(response, fallbackMessage) {
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
        throw new OverlayTemplateAssetApiError(body?.message || fallbackMessage, {
            code: body?.code || "OVERLAY_TEMPLATE_ASSET_REQUEST_FAILED",
            status: response.status,
        });
    }
    return body;
}

async function readImageDimensions(file) {
    if (typeof createImageBitmap !== "function") {
        return { width: 1, height: 1 };
    }
    try {
        const bitmap = await createImageBitmap(file);
        const dimensions = {
            width: Math.max(1, Math.round(Number(bitmap.width) || 1)),
            height: Math.max(1, Math.round(Number(bitmap.height) || 1)),
        };
        bitmap.close?.();
        return dimensions;
    } catch {
        return { width: 1, height: 1 };
    }
}

export async function listOverlayTemplateAssetsRequest({
    fetchImpl = globalThis.fetch,
} = {}) {
    if (typeof fetchImpl !== "function") {
        throw new OverlayTemplateAssetApiError("Template media storage is unavailable.", {
            code: "OVERLAY_TEMPLATE_ASSET_FETCH_UNAVAILABLE",
        });
    }
    const response = await fetchImpl(`${ASSET_API_PATH}?limit=100`, {
        credentials: "include",
    });
    const body = await readJsonResponse(response, "Template media could not be loaded.");
    return (Array.isArray(body.assets) ? body.assets : [])
        .filter((asset) => (
            asset?.media_type === "image"
            && SUPPORTED_IMAGE_MIME_TYPES.includes(normalizeMimeType(asset?.mime_type))
            && asset?.metadata?.scope === "overlay-template"
        ))
        .map(normalizeAsset);
}

export async function uploadOverlayTemplateAssetRequest(file, {
    fetchImpl = globalThis.fetch,
} = {}) {
    if (typeof fetchImpl !== "function") {
        throw new OverlayTemplateAssetApiError("Template media storage is unavailable.", {
            code: "OVERLAY_TEMPLATE_ASSET_FETCH_UNAVAILABLE",
        });
    }
    if (!isSupportedOverlayTemplateImage(file)) {
        throw new OverlayTemplateAssetApiError(
            "Choose a PNG, JPEG, WebP, or safe SVG image.",
            { code: "UNSUPPORTED_TEMPLATE_IMAGE" },
        );
    }

    const dimensions = await readImageDimensions(file);
    const response = await fetchImpl(`${ASSET_API_PATH}/upload`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": uploadMimeType(file),
            "X-File-Name": encodeURIComponent(file.name || "template-image"),
            "X-Image-Width": String(dimensions.width),
            "X-Image-Height": String(dimensions.height),
        },
        body: file,
    });
    const body = await readJsonResponse(response, "Template image could not be uploaded.");
    return normalizeAsset(body.asset);
}
