import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Header } from '../../web/src/components/Header';
import { member, renderWithApi } from './fakes';

describe('help overlay', () => {
  it('opens from the ? button with the Lineup and meeting-cycle explainers, and closes', async () => {
    renderWithApi(<Header user={member} onSignOut={() => {}} />);
    const user = userEvent.setup();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'How it works' }));
    const dialog = screen.getByRole('dialog', { name: 'How it works' });
    expect(within(dialog).getByRole('heading', { name: /From idea to/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: /Pass the/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: /The meeting cycle/ })).toBeInTheDocument();
    // The five Lineup steps, in order.
    const steps = within(dialog).getAllByRole('list')[0]!;
    expect(within(steps).getAllByRole('listitem').map((li) => li.querySelector('p')!.textContent)).toEqual([
      'Nominate',
      'Vote ▲',
      'Leader picks',
      'Read & meet',
      'The Shelf',
    ]);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
