import { query as defaultQuery } from "../index.js";

const TEMPLATE_COLUMNS = `id, owner_id, name, description, schema_version, canvas, elements, metadata, created_at, updated_at`;

export async function createOverlayTemplate({
    ownerId,
    name,
    description = null,
    schemaVersion = 1,
    canvas = {},
    elements = [],
    metadata = {},
}, executor = null) {
    const q = executor ? executor.query.bind(executor) : defaultQuery;
    const sql = `
    INSERT INTO overlay_templates (
      owner_id, name, description, schema_version, canvas, elements, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING ${TEMPLATE_COLUMNS};
  `;
    const result = await q(sql, [
        ownerId,
        name,
        description,
        schemaVersion,
        JSON.stringify(canvas),
        JSON.stringify(elements),
        JSON.stringify(metadata),
    ]);
    return result.rows[0];
}

export async function getOverlayTemplateById(id, executor = null) {
    const q = executor ? executor.query.bind(executor) : defaultQuery;
    const sql = `
    SELECT ${TEMPLATE_COLUMNS}
    FROM overlay_templates
    WHERE id = $1;
  `;
    const result = await q(sql, [id]);
    return result.rows[0] || null;
}

export async function listOverlayTemplatesByOwner(ownerId, { limit = 50, offset = 0, search = null } = {}, executor = null) {
    const q = executor ? executor.query.bind(executor) : defaultQuery;
    const values = [ownerId, limit, offset];
    let searchClause = "";

    if (typeof search === "string" && search.trim()) {
        values.push(`%${search.trim()}%`);
        searchClause = `AND name ILIKE $${values.length}`;
    }

    const sql = `
    SELECT ${TEMPLATE_COLUMNS}
    FROM overlay_templates
    WHERE owner_id = $1 ${searchClause}
    ORDER BY updated_at DESC
    LIMIT $2 OFFSET $3;
  `;
    const result = await q(sql, values);
    return result.rows;
}

export async function updateOverlayTemplate(id, updates = {}, executor = null) {
    const q = executor ? executor.query.bind(executor) : defaultQuery;
    const allowed = ["name", "description", "schema_version", "canvas", "elements", "metadata"];
    const jsonColumns = new Set(["canvas", "elements", "metadata"]);
    const setClauses = [];
    const values = [id];
    let paramIndex = 2;

    for (const [key, value] of Object.entries(updates)) {
        if (!allowed.includes(key)) continue;
        setClauses.push(`${key} = $${paramIndex}`);
        values.push(jsonColumns.has(key) ? JSON.stringify(value) : value);
        paramIndex += 1;
    }

    if (setClauses.length === 0) return getOverlayTemplateById(id, executor);

    setClauses.push("updated_at = NOW()");

    const sql = `
    UPDATE overlay_templates
    SET ${setClauses.join(", ")}
    WHERE id = $1
    RETURNING ${TEMPLATE_COLUMNS};
  `;
    const result = await q(sql, values);
    return result.rows[0] || null;
}

export async function deleteOverlayTemplate(id, executor = null) {
    const q = executor ? executor.query.bind(executor) : defaultQuery;
    const sql = `
    DELETE FROM overlay_templates
    WHERE id = $1
    RETURNING id;
  `;
    const result = await q(sql, [id]);
    return Boolean(result.rowCount);
}
