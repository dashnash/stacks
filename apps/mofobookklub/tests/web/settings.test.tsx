import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsView } from '../../web/src/views/SettingsView';
import { fakeApi, member, renderWithApi } from './fakes';

describe('settings', () => {
  it('shows your card and sends you to your platform profile to change your name', async () => {
    renderWithApi(<SettingsView user={member} />, fakeApi());
    expect(screen.getByText('Alice')).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /Change your name/ });
    await expect.poll(() => link.getAttribute('href')).toBe('https://auth.club.test/#/profile');
  });
});
