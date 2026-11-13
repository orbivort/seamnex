import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProductVersion } from '../../src/product-version';

/**
 * The footer line has one job: name the build in front of the reader. These tests pin the shape of
 * the tag and the two ways the build can fail to have a version, because a footer that quietly
 * prints nothing is the state that leaves an operator unable to tell two builds apart.
 */
describe('ProductVersion', () => {
  it('prints the version as a tag', () => {
    render(<ProductVersion version="1.4.2" />);

    expect(screen.getByText('v1.4.2')).toBeDefined();
  });

  it('keeps a pre-release suffix instead of parsing it away', () => {
    render(<ProductVersion version="2.0.0-rc.1" />);

    expect(screen.getByText('v2.0.0-rc.1')).toBeDefined();
  });

  it('trims the whitespace a hand-edited manifest can carry', () => {
    render(<ProductVersion version="  3.1.0  " />);

    expect(screen.getByText('v3.1.0')).toBeDefined();
  });

  it('says the version is unavailable when the build could not read the manifest', () => {
    render(<ProductVersion version="unknown" />);

    expect(screen.getByText('version unavailable')).toBeDefined();
  });

  it('treats a blank value as unavailable rather than printing a bare "v"', () => {
    render(<ProductVersion version="   " />);

    expect(screen.getByText('version unavailable')).toBeDefined();
  });
});
