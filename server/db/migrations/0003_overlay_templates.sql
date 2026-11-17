-- Phase 3: Global (user-scoped) Overlay Template Library
-- Stores reusable, editable overlay template definitions per user.
-- Templates are *definitions only*: no rendered media, no flattened screenshots.
-- Media binaries are never stored here; elements carry portable references instead.

CREATE TABLE IF NOT EXISTS overlay_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    description TEXT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    canvas JSONB NOT NULL DEFAULT '{}'::jsonb,
    elements JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_overlay_templates_owner_id ON overlay_templates(owner_id);
CREATE INDEX IF NOT EXISTS idx_overlay_templates_updated_at ON overlay_templates(owner_id, updated_at DESC);
