import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BuildVersion } from '../src/index';

describe('BuildVersion', () => {
  it('links the short hash to the commit', () => {
    render(<BuildVersion sha="0123456789abcdef" repoUrl="https://github.com/o/r/" className="x" />);
    const link = screen.getByRole('link', { name: 'Build 0123456' });
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/commit/0123456789abcdef');
    expect(link).toHaveAttribute('data-stacks-build', '0123456789abcdef');
    expect(link).toHaveClass('x');
  });

  it('shows the hash without a link when the repository is unknown, and "Build dev" locally', () => {
    const { container } = render(<BuildVersion sha="0123456789abcdef" repoUrl="" />);
    expect(screen.getByText('Build 0123456').tagName).toBe('SPAN');
    expect(container.querySelector('a')).toBeNull();
    render(<BuildVersion sha="" repoUrl="" />);
    expect(screen.getByText('Build dev')).toHaveAttribute('data-stacks-build', 'dev');
  });
});
