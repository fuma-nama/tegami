import typia from "typia";

/** A single entry in composer.json `repositories`. */
export interface ComposerRepository {
  type?: string;
  url?: string;
}

/**
 * A minimal view of `composer.json`.
 *
 * Only the fields Tegami reads or edits are typed. Additional keys (e.g.
 * `autoload`, `description`) are preserved untouched because the parsed object
 * is mutated and re-serialized in place.
 */
export interface ComposerManifest {
  name?: string;
  version?: string;
  require?: Record<string, string>;
  "require-dev"?: Record<string, string>;
  repositories?: ComposerRepository[] | Record<string, ComposerRepository>;
}

/** Packagist metadata API (`/p2/{vendor/name}.json`) response shape. */
export interface ComposerRegistryResponse {
  packages: Record<string, { version: string }[]>;
}

export const assertComposerManifest: (input: unknown) => ComposerManifest =
  typia.createAssert<ComposerManifest>();

export const validateRegistryResponse: (
  input: unknown,
) => typia.IValidation<ComposerRegistryResponse> = typia.createValidate<ComposerRegistryResponse>();
