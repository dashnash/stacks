import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { CriticPhotos } from '../../web/src/components/CriticPhotos';
import { fakeApi, renderWithApi } from './fakes';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(16).fill(1)]);
const zipFile = (files: Record<string, Uint8Array>, name = 'faces.zip') => new File([zipSync(files) as BlobPart], name, { type: 'application/zip' });

describe('CriticPhotos', () => {
  it('checks a zip, shows what it found, and adds the photos', async () => {
    const faces = vi
      .fn()
      .mockResolvedValueOnce({ faces: [] })
      .mockResolvedValue({ faces: [{ name: 'id-1.jpg', url: 'https://signed/id-1.jpg' }, { name: 'id-2.jpg', url: 'https://signed/id-2.jpg' }] });
    const api = fakeApi({ faces });
    renderWithApi(<CriticPhotos />, api);
    const user = userEvent.setup();
    expect(await screen.findByText(/No faces yet/)).toBeInTheDocument();

    await user.upload(screen.getByLabelText('Zip of face photos'), zipFile({ 'a.jpg': JPEG, 'b.jpg': JPEG, 'notes.txt': Uint8Array.from('hi', (c) => c.charCodeAt(0)) }));
    expect(await screen.findByText('Found 2 photos in faces.zip.')).toBeInTheDocument();
    expect(screen.getByText(/Skipping 1 file that isn't a photo: notes.txt/)).toBeInTheDocument();
    expect(api.uploadFaces).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Add 2 photos' }));
    expect(await screen.findByText('Added 2 photos.')).toBeInTheDocument();
    expect(api.uploadFaces).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(api.uploadFaces).mock.calls[0]![0];
    expect(sent.map((p) => p.fileName)).toEqual(['a.jpg', 'b.jpg']);
    expect(atob(sent[0]!.data).charCodeAt(0)).toBe(0xff);
    const grid = await screen.findByRole('list', { name: 'Face photos' });
    expect(within(grid).getAllByRole('img')).toHaveLength(2);
  });

  it('refuses a zip with no photos, and uploads nothing', async () => {
    const api = fakeApi();
    renderWithApi(<CriticPhotos />, api);
    await userEvent.setup().upload(screen.getByLabelText('Zip of face photos'), zipFile({ 'readme.txt': Uint8Array.from('hi', (c) => c.charCodeAt(0)) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No photos in that zip (found readme.txt).');
    expect(screen.queryByRole('button', { name: /^Add/ })).not.toBeInTheDocument();
    expect(api.uploadFaces).not.toHaveBeenCalled();
  });

  it('deletes a photo after confirming', async () => {
    const faces = vi
      .fn()
      .mockResolvedValueOnce({ faces: [{ name: 'a.jpg', url: 'https://signed/a.jpg' }] })
      .mockResolvedValue({ faces: [] });
    const api = fakeApi({ faces });
    renderWithApi(<CriticPhotos />, api);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Delete a.jpg' }));
    expect(api.deleteFace).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.deleteFace).toHaveBeenCalledWith('a.jpg');
    await waitFor(() => expect(screen.getByText(/No faces yet/)).toBeInTheDocument());
  });
});
