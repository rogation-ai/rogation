-- Product context as first-class input (L1)
-- Design doc: hamza-sanxore-product-context-input-design-20260511-104601.md

-- Account-level product context storage + feature flags
ALTER TABLE "account"
  ADD COLUMN "product_brief" text,
  ADD COLUMN "product_brief_structured" jsonb,
  ADD COLUMN "flag_product_context_v1" boolean NOT NULL DEFAULT false,
  ADD COLUMN "flag_product_context_v1_rotation" text NOT NULL DEFAULT 'off'
    CHECK ("flag_product_context_v1_rotation" IN ('on', 'off', 'rotate'));

-- context_used on result tables for eval rotation tracking
ALTER TABLE "insight_cluster"
  ADD COLUMN "context_used" boolean;

ALTER TABLE "opportunity"
  ADD COLUMN "context_used" boolean;

ALTER TABLE "spec"
  ADD COLUMN "context_used" boolean;

-- Denormalized context_used on entity_feedback for single-table aggregation
ALTER TABLE "entity_feedback"
  ADD COLUMN "context_used" boolean;
