import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BuildVersion, LegalLinks } from '../../web/src/views/SignInView';

const SHA = '3de8281f0c1e2a4b5d6e7f8091a2b3c4d5e6f708';

describe('build version in the footer', () => {
  it('shows the short hash, linking to the commit on GitHub', () => {
    render(<BuildVersion sha={SHA} commitUrl={`https://github.com/dashnash/MofoBookKlubPortal/commit/${SHA}`} />);
    const link = screen.getByRole('link', { name: 'Build 3de8281' });
    expect(link).toHaveAttribute('href', `https://github.com/dashnash/MofoBookKlubPortal/commit/${SHA}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('title', `Deployed from commit ${SHA}`);
  });

  it('shows just the hash when the repository is unknown, and nothing without a commit', () => {
    const { rerender, container } = render(<BuildVersion sha={SHA} commitUrl="" />);
    expect(screen.getByText('Build 3de8281')).not.toHaveAttribute('href');
    rerender(<BuildVersion sha="" commitUrl="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is in the footer, using the commit this build was made from', () => {
    render(<LegalLinks />);
    // Vite injects the real commit at build (and test) time.
    expect(screen.getByText(/^Build [0-9a-f]{7}$/)).toBeInTheDocument();
  });
});
