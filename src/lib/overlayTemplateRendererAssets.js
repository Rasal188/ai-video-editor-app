function readChecksum(asset) {
    return String(
        asset?.integrity?.sha256
        || asset?.sha256
        || asset?.checksum
        || "",
    );
}

export function buildOverlayTemplateAssetIndex(assets = []) {
    const byAssetId = new Map();
    const byArchiveMediaId = new Map();
    const byChecksum = new Map();

    for (const asset of Array.isArray(assets) ? assets : []) {
        if (!asset || typeof asset !== "object") continue;
        if (asset.id) byAssetId.set(String(asset.id), asset);
        if (asset.assetId) byAssetId.set(String(asset.assetId), asset);
        if (asset.archiveMediaId) {
            byArchiveMediaId.set(String(asset.archiveMediaId), asset);
        }
        const checksum = readChecksum(asset);
        if (checksum) byChecksum.set(checksum, asset);
    }

    return { byAssetId, byArchiveMediaId, byChecksum };
}

export function resolveOverlayTemplateMediaAsset(media, index) {
    if (!media || !index) return null;
    if (media.assetId && index.byAssetId.has(media.assetId)) {
        return index.byAssetId.get(media.assetId);
    }
    if (
        media.archiveMediaId
        && index.byArchiveMediaId.has(media.archiveMediaId)
    ) {
        return index.byArchiveMediaId.get(media.archiveMediaId);
    }
    if (media.checksum && index.byChecksum.has(media.checksum)) {
        return index.byChecksum.get(media.checksum);
    }
    return null;
}
