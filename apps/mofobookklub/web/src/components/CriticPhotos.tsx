import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../lib/auth';
import { batches, describeSkipped, readFacesZip, shrinkPhoto, toBase64, type ZipContents } from '../lib/face-zip';
import { useAsync } from '../lib/useAsync';
import { ErrorNote, Spinner } from './ui';

type Stage =
  | { name: 'idle' }
  | { name: 'checked'; zipName: string; contents: ZipContents }
  | { name: 'uploading'; done: number; total: number };

/**
 * The face photos on the critics' quotes (admin page): add a zip of photos, see them all, delete
 * any. Quotes are unsigned, so every face goes with every quote. Photos live only in the app's
 * private content bucket, never in git.
 */
export function CriticPhotos() {
  const api = useApi();
  const faces = useAsync(() => api.faces().then((r) => r.faces), []);
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The <input> is remounted after each zip so choosing the same file again still fires.
  const [inputKey, setInputKey] = useState(0);

  async function chooseZip(file: File | undefined) {
    setError(null);
    setNotice(null);
    if (!file) return;
    try {
      const contents = readFacesZip(await readFile(file));
      setStage({ name: 'checked', zipName: file.name, contents });
    } catch (err) {
      setStage({ name: 'idle' });
      setError(err as Error);
    } finally {
      setInputKey((k) => k + 1);
    }
  }

  async function upload(contents: ZipContents) {
    setError(null);
    const total = contents.photos.length;
    let done = 0;
    setStage({ name: 'uploading', done, total });
    try {
      const small = [];
      for (const p of contents.photos) small.push(await shrinkPhoto(p));
      for (const batch of batches(small)) {
        await api.uploadFaces(batch.map((p) => ({ fileName: p.fileName, data: toBase64(p.bytes) })));
        done += batch.length;
        setStage({ name: 'uploading', done, total });
      }
      setNotice(`Added ${total === 1 ? '1 photo' : `${total} photos`}.`);
    } catch (err) {
      setError(new Error(`${(err as Error).message}${done ? ` (${done} of ${total} were added before this)` : ''}`));
    } finally {
      setStage({ name: 'idle' });
      await faces.reload();
    }
  }

  async function remove(name: string) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await api.deleteFace(name);
      setConfirming(null);
      await faces.reload();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  }

  const list = faces.data ?? [];
  return (
    <div className="space-y-6">
      <section aria-labelledby="add-faces" className="space-y-3">
        <p id="add-faces" className="kicker">
          Add face photos
        </p>
        <p className="text-sm text-ink/70">
          Upload a .zip of face photos (JPEG, PNG, GIF or WebP). Each one is checked, shrunk and stripped of its
          camera and location details, then joins the faces shown on the critics' quotes at the bottom of the home page.
        </p>
        {stage.name === 'idle' && (
          <label className="btn-primary inline-flex cursor-pointer !px-4 !py-1.5 focus-within:outline focus-within:outline-2">
            Choose a zip
            <input
              key={inputKey}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              className="sr-only"
              aria-label="Zip of face photos"
              onChange={(e) => void chooseZip(e.target.files?.[0])}
            />
          </label>
        )}
        {stage.name === 'checked' && (
          <ZipPreview
            zipName={stage.zipName}
            contents={stage.contents}
            onCancel={() => setStage({ name: 'idle' })}
            onAdd={() => void upload(stage.contents)}
          />
        )}
        {stage.name === 'uploading' && <Spinner label={`Adding photos: ${stage.done} of ${stage.total}`} />}
        <ErrorNote error={error} />
        {notice && (
          <p role="status" className="border-2 border-ink bg-sun/30 px-3 py-2 text-sm font-semibold">
            {notice}
          </p>
        )}
      </section>

      <section aria-labelledby="current-faces" className="space-y-3">
        <p id="current-faces" className="kicker">
          Faces on the quotes · {faces.data ? list.length : '…'}
        </p>
        <ErrorNote error={faces.error} />
        {faces.data && list.length === 0 && (
          <p className="voice text-2xl">No faces yet. The critics are silhouettes until you add some.</p>
        )}
        <ul aria-label="Face photos" className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
          {list.map((f) => (
            <li key={f.name} className="border-2 border-ink bg-paper">
              <img src={f.url} alt={`Face photo ${f.name}`} loading="lazy" className="block aspect-square w-full object-cover" />
              <div className="flex min-h-[2.75rem] flex-wrap items-center justify-center gap-1 border-t-2 border-ink p-1.5 text-sm">
                {confirming === f.name ? (
                  <>
                    <button type="button" className="btn-ghost !px-2 !py-0.5" disabled={busy !== null} onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                    <button type="button" className="btn-accent !px-2 !py-0.5" disabled={busy !== null} onClick={() => void remove(f.name)}>
                      Delete
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-ghost !px-3 !py-0.5"
                    disabled={busy !== null || stage.name === 'uploading'}
                    onClick={() => setConfirming(f.name)}
                    aria-label={`Delete ${f.name}`}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** A chosen file's bytes (FileReader where `Blob.arrayBuffer` is missing, as in jsdom). */
function readFile(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsArrayBuffer(file);
  });
}

/** What was found in the chosen zip, before anything is uploaded. */
function ZipPreview({ zipName, contents, onCancel, onAdd }: { zipName: string; contents: ZipContents; onCancel: () => void; onAdd: () => void }) {
  const { photos, skipped } = contents;
  const urls = useMemo(
    () => (typeof URL.createObjectURL === 'function' ? photos.map((p) => URL.createObjectURL(new Blob([p.bytes as BlobPart], { type: p.contentType }))) : []),
    [photos],
  );
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const count = photos.length === 1 ? '1 photo' : `${photos.length} photos`;

  return (
    <div className="space-y-3 border-2 border-ink p-3">
      <p className="font-semibold">
        Found {count} in {zipName}.
      </p>
      {skipped.length > 0 && (
        <p className="text-sm text-ink/70">
          Skipping {skipped.length === 1 ? '1 file' : `${skipped.length} files`} that {skipped.length === 1 ? "isn't a photo" : "aren't photos"}:{' '}
          {describeSkipped(skipped)}.
          {skipped.some((s) => s.reason.startsWith('HEIC')) && ' iPhone HEIC photos need exporting as JPEG first.'}
        </p>
      )}
      {urls.length > 0 && (
        <ul aria-label="Photos in the zip" className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
          {urls.map((u, i) => (
            <li key={u}>
              <img src={u} alt={photos[i]!.fileName} className="h-16 w-16 border border-ink object-cover" />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-ghost !px-4 !py-1.5" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-accent !px-4 !py-1.5" onClick={onAdd}>
          Add {count}
        </button>
      </div>
    </div>
  );
}
