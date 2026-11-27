-- 0040 — NFR-4.6 / S-10: retain the vulnerability scan of the image an instance is about to run.
--
-- The review found the only scan in the platform was Trivy over `seamnex-api` in CI, printed to a
-- log and kept nowhere, while no product image was ever scanned. "Results retained" is the
-- requirement's own wording, so the row is the evidence: which digest was scanned, by which scanner
-- and database revision, what it found, and whether that blocked the deployment.
--
-- `blocking_severities` is stored with the row rather than read from configuration at display time:
-- a verdict has to stay explainable after an operator changes the threshold, and a report that
-- suddenly reads "passed" because the rules moved is the defect this table exists to prevent.
--
-- One row per (instance, digest, scanner): re-deploying the same pinned digest reuses the retained
-- report instead of rescanning, and a rescan of the same digest is an UPDATE of that row.

CREATE TABLE image_scan_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
  image_ref text NOT NULL,
  image_digest text NOT NULL,
  scanner text NOT NULL,
  scanner_version text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('passed', 'blocked', 'error')),
  blocking_severities text[] NOT NULL DEFAULT '{}',
  severity_counts jsonb NOT NULL,
  findings jsonb NOT NULL,
  -- Object key or path of the raw scanner report, when the operator retains one.
  report_key text,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT image_scan_result_one_per_digest UNIQUE (instance_id, image_digest, scanner),
  CONSTRAINT image_scan_result_counts_object CHECK (jsonb_typeof(severity_counts) = 'object'),
  CONSTRAINT image_scan_result_findings_array CHECK (jsonb_typeof(findings) = 'array')
);

-- The instance screen reads the newest row per digest; the retention sweep deletes by age.
CREATE INDEX image_scan_result_instance_idx
  ON image_scan_result (instance_id, scanned_at DESC);
CREATE INDEX image_scan_result_scanned_at_idx
  ON image_scan_result (scanned_at);

-- UPDATE is the rescan path and DELETE is the retention sweep; both are bounded by the service.
GRANT SELECT, INSERT, UPDATE, DELETE ON image_scan_result TO seamnex_app;

COMMENT ON TABLE image_scan_result IS
  'NFR-4.6 retained product-image scan reports, one per instance/image digest/scanner.';
