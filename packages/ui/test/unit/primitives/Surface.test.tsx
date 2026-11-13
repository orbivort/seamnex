import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Callout,
  DefinitionList,
  Divider,
  Panel,
  PanelHeader,
  Stat,
} from '../../../src/primitives/Surface';
import { toneText } from '../../../src/primitives/tone';

/**
 * The surface primitives. Nothing here has state, so the contract is structural: a panel keeps
 * its print contract, a stat never loses its tone, and every optional slot disappears cleanly
 * instead of leaving an empty node behind.
 */
describe('Panel', () => {
  it('renders a section by default and keeps the print contract', () => {
    const { container } = render(<Panel>body</Panel>);
    const panel = container.querySelector('section');
    expect(panel?.className).toContain('print-block');
    expect(panel?.className).not.toContain('p-4');
  });

  it('can be a div, an article or an aside', () => {
    const { container, rerender } = render(<Panel as="div">body</Panel>);
    expect(container.querySelector('div')).not.toBeNull();
    rerender(<Panel as="article">body</Panel>);
    expect(container.querySelector('article')).not.toBeNull();
    rerender(<Panel as="aside">body</Panel>);
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it('applies the body inset only when inset is set, and keeps a caller class', () => {
    const { container, rerender } = render(
      <Panel inset className="extra-marker">
        body
      </Panel>,
    );
    const panel = container.querySelector('section');
    expect(panel?.className).toContain('p-4');
    expect(panel?.className).toContain('extra-marker');
    rerender(<Panel>body</Panel>);
    expect(container.querySelector('section')?.className).not.toContain('p-4');
  });
});

describe('PanelHeader', () => {
  it('renders the title with a divider by default', () => {
    const { container } = render(<PanelHeader title="Deployments" />);
    const header = container.querySelector('header');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Deployments');
    expect(header?.className).toContain('border-b');
  });

  it('fills every optional slot', () => {
    render(
      <PanelHeader
        eyebrow="Catalog"
        title="Deployments"
        description="Everything that ever ran"
        actions={<button type="button">Refresh</button>}
      />,
    );
    expect(screen.getByText('Catalog').className).toContain('label-caps');
    expect(screen.getByText('Everything that ever ran').tagName).toBe('P');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined();
  });

  it('drops the divider and every empty slot when asked', () => {
    const { container } = render(<PanelHeader title="Deployments" divider={false} />);
    const header = container.querySelector('header');
    expect(header?.className).not.toContain('border-b');
    expect(container.querySelectorAll('p')).toHaveLength(0);
    expect(header?.querySelector('div > div')).toBeNull();
  });

  it('keeps a caller class', () => {
    const { container } = render(<PanelHeader title="Deployments" className="extra-marker" />);
    expect(container.querySelector('header')?.className).toContain('extra-marker');
  });
});

describe('Stat', () => {
  it('reads as plain text when neutral', () => {
    render(<Stat label="Instances" value="12" />);
    expect(screen.getByText('12').className).toContain('text-text');
  });

  it('uses the primary step for an accent stat', () => {
    render(<Stat label="Instances" value="12" tone="accent" />);
    expect(screen.getByText('12').className).toContain('text-primary');
  });

  it('uses the tone recipe for a status stat', () => {
    render(<Stat label="Instances" value="12" tone="positive" />);
    expect(screen.getByText('12').className).toContain(toneText('positive'));
  });

  it('renders the hint and a caller class when supplied', () => {
    const { container } = render(
      <Stat label="Instances" value="12" hint="+2 this week" className="extra-marker" />,
    );
    expect(screen.getByText('+2 this week').className).toContain('text-muted');
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
  });

  it('omits the hint when there is none', () => {
    const { container } = render(<Stat label="Instances" value="12" />);
    expect(container.querySelectorAll('span')).toHaveLength(2);
  });
});

describe('DefinitionList', () => {
  it('is a two-column grid by default', () => {
    const { container } = render(
      <DefinitionList items={[{ label: 'Region', value: 'eu-west-1' }]} />,
    );
    const list = container.querySelector('dl');
    expect(list?.className).toContain('sm:grid-cols-2');
    expect(screen.getByText('Region').tagName).toBe('DT');
    expect(screen.getByText('eu-west-1').tagName).toBe('DD');
  });

  it('narrows to one column', () => {
    const { container } = render(
      <DefinitionList columns={1} items={[{ label: 'Region', value: 'eu-west-1' }]} />,
    );
    expect(container.querySelector('dl')?.className).toContain('grid-cols-1');
  });

  it('widens to three columns above lg', () => {
    const { container } = render(
      <DefinitionList columns={3} items={[{ label: 'Region', value: 'eu-west-1' }]} />,
    );
    expect(container.querySelector('dl')?.className).toContain('lg:grid-cols-3');
  });

  it('renders a mono value with its hint', () => {
    render(
      <DefinitionList
        items={[{ label: 'Checksum', value: 'sha256:abc', mono: true, hint: 'signed' }]}
      />,
    );
    const value = screen.getByText('sha256:abc');
    expect(value.tagName).toBe('DD');
    expect(value.className).toContain('font-mono');
    expect(screen.getByText('signed').className).toContain('text-faint');
  });

  it('keeps a mono value unstyled as prose when mono is off, and accepts a class', () => {
    const { container } = render(
      <DefinitionList className="extra-marker" items={[{ label: 'Region', value: 'eu-west-1' }]} />,
    );
    expect(screen.getByText('eu-west-1').className).not.toContain('font-mono');
    expect(container.querySelector('dl')?.className).toContain('extra-marker');
  });
});

describe('Divider', () => {
  it('is a horizontal rule that takes a caller class', () => {
    const { container, rerender } = render(<Divider />);
    expect(container.querySelector('hr')?.className).toContain('border-t');
    rerender(<Divider className="extra-marker" />);
    expect(container.querySelector('hr')?.className).toContain('extra-marker');
  });
});

describe('Callout', () => {
  it('carries the tone box and the title', () => {
    const { container } = render(<Callout tone="info" title="Heads up" />);
    const callout = container.firstElementChild as HTMLElement;
    expect(callout.className).toContain('border-info-border');
    expect(screen.getByText('Heads up').className).toContain('font-semibold');
  });

  it('renders the icon, the body and the action when supplied', () => {
    render(
      <Callout
        tone="caution"
        title="Heads up"
        icon={<span data-testid="icon" />}
        action={<button type="button">Dismiss</button>}
      >
        The queue is backing up.
      </Callout>,
    );
    expect(screen.getByTestId('icon').parentElement?.className).toContain('shrink-0');
    expect(screen.getByText('The queue is backing up.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDefined();
  });

  it('leaves the optional slots out entirely', () => {
    const { container } = render(<Callout tone="info" title="Heads up" />);
    const callout = container.firstElementChild as HTMLElement;
    expect(callout.querySelectorAll('div')).toHaveLength(1);
    expect(callout.querySelectorAll('span')).toHaveLength(0);
  });

  it('keeps a caller class', () => {
    const { container } = render(
      <Callout tone="danger" title="Heads up" className="extra-marker" />,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
  });
});
