import { useState, type FormEvent } from 'react';
import { Avatar, ErrorNote } from '@stacks/web';
import { usePortal } from '../portal';
import { BackToApp } from './BackToApp';

export function Profile({ from }: { from?: string }) {
  const { api, me, refresh } = usePortal();
  const [name, setName] = useState(me?.user.displayName ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    setError(null);
    try {
      await api.updateProfile(name.trim() || null);
      await refresh();
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card narrow">
      <BackToApp from={from} />
      <h1>Profile</h1>
      <div className="row-gap">
        <Avatar person={{ name: me.user.name, pictureUrl: me.user.pictureUrl ?? undefined }} size={56} className="avatar" />
        <div>
          <strong>{me.user.name}</strong>
          <p className="muted small">{me.user.email}</p>
        </div>
      </div>
      <form onSubmit={save} className="stack">
        <label htmlFor="display-name">Name shown in every app</label>
        <input id="display-name" maxLength={30} value={name} placeholder={me.user.googleName.split(/\s+/)[0]} onChange={(e) => setName(e.target.value)} />
        <p className="muted small">Leave empty to use your first name. Apps never see your full Google name.</p>
        <button type="submit" className="button">
          Save
        </button>
        {saved && <p role="status">Saved. Every app shows your new name within a minute.</p>}
        <ErrorNote error={error} className="error" />
      </form>
    </section>
  );
}
