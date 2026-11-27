/**
 * Generated from `docker/images.json` — do not edit by hand.
 *
 * `pnpm images:generate` writes this file and `pnpm check:images:offline` fails when it disagrees
 * with the manifest. The API imports it instead of a literal so one file decides which binary
 * runs, and the compose stack is checked against that same file.
 */

export const ALPINE_IMAGE =
  'alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf';

export const BUSYBOX_IMAGE =
  'busybox:1.38.0@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4';

export const POSTGRES_IMAGE =
  'postgres:18.7-alpine@sha256:0115267ab5a509022df9319c77be365cef335adb71556c75f60f5360ee247e71';

export const TRIVY_IMAGE =
  'aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb';
