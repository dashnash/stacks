import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LegalLinks } from '../../web/src/views/SignInView';

describe('build version in the footer', () => {
  it('is in the footer on every screen (the shared <BuildVersion />)', () => {
    const { container } = render(<LegalLinks />);
    expect(container.querySelector('footer [data-stacks-build]')).not.toBeNull();
  });
});
