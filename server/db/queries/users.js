import { query as defaultQuery } from "../index.js";

export async function createUser({ email, name, passwordHash = null }, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    INSERT INTO users (email, name, password_hash)
    VALUES ($1, $2, $3)
    RETURNING id, email, name, created_at, updated_at;
  `;
  const result = await q(sql, [email.toLowerCase().trim(), name.trim(), passwordHash]);
  return result.rows[0];
}

export async function getUserById(id, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, email, name, password_hash, created_at, updated_at
    FROM users
    WHERE id = $1;
  `;
  const result = await q(sql, [id]);
  return result.rows[0] || null;
}

export async function getUserByEmail(email, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, email, name, password_hash, created_at, updated_at
    FROM users
    WHERE LOWER(email) = LOWER($1);
  `;
  const result = await q(sql, [email.trim()]);
  return result.rows[0] || null;
}

export async function listUsers({ limit = 50, offset = 0 } = {}, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    SELECT id, email, name, created_at, updated_at
    FROM users
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2;
  `;
  const result = await q(sql, [limit, offset]);
  return result.rows;
}

export async function deleteUser(id, executor = null) {
  const q = executor ? executor.query.bind(executor) : defaultQuery;
  const sql = `
    DELETE FROM users
    WHERE id = $1
    RETURNING id;
  `;
  const result = await q(sql, [id]);
  return Boolean(result.rowCount);
}
