/**
 * The "cheap knockoff" trimmings. Every glitch here is cosmetic: nothing blocks playing,
 * signing in or saving. Browser storage is only a per-visitor convenience (wrapped in try/catch).
 */
import { useEffect, useState } from 'react';

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window: fine */
  }
}

export function Marquee() {
  const text =
    '!!! NEW 2019 VERSION !!! БЕСПЛАТНО flip the table for relax of stress *** Recomended by 9 of 10 docter *** now with physic engine *** ';
  return (
    <div className="marquee" aria-hidden="true">
      <span>{text.repeat(3)}</span>
    </div>
  );
}

/** "You are visitor №…": a different (wrong) number every load. */
export function VisitorCounter() {
  const [n] = useState(() => 1_000_000 + Math.floor(Math.random() * 90));
  return (
    <p className="counter">
      You are visitor №<span className="digits">{n.toLocaleString('en-US')}</span> (congratulation!!)
    </p>
  );
}

/** A sale that always ends very soon, then gets "extended". */
export function SaleTimer() {
  const [left, setLeft] = useState(12);
  const [extended, setExtended] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          setExtended(true);
          setTimeout(() => setExtended(false), 2500);
          return 599;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <p className="sale">
      🔥 СКИДКА -70% on all flip! Ends in{' '}
      <span className="digits">
        00:{mm}:{ss}
      </span>
      {extended && <strong className="blink"> АКЦИЯ ПРОДЛЕНА! (sale extend)</strong>}
    </p>
  );
}

/** Cookie banner that comes back exactly once after you close it. */
export function CookieBanner() {
  const [stage, setStage] = useState(() => Number(readLocal('fwt.cookie') ?? '0'));
  useEffect(() => {
    if (stage !== 1) return;
    const id = setTimeout(() => setStage(1.5), 15_000);
    return () => clearTimeout(id);
  }, [stage]);
  if (stage === 1 || stage >= 2) return null;
  const close = () => {
    const next = stage === 0 ? 1 : 2;
    writeLocal('fwt.cookie', String(next));
    setStage(next);
  };
  return (
    <div className="cookie" role="region" aria-label="Cookie notice">
      <p>
        {stage === 0
          ? '🍪 We use cookie (печенье) for best experiance of you. By flip you agree.'
          : '🍪 Sorry we ask again. Cookie is still use. Thank for understand.'}
      </p>
      <button type="button" onClick={close}>
        Ok
      </button>
      <button type="button" onClick={close}>
        Ok but sad
      </button>
    </div>
  );
}

export function FakeDownload({ onToast }: { onToast: (msg: string) => void }) {
  return (
    <div className="ad">
      <div className="broken-img" role="img" aria-label="Broken banner image">
        [img] banner_final_FINAL(2).jpg
      </div>
      <button type="button" className="download" onClick={() => onToast('ошибка 0x000FL1P: FULL VERSION is the version you are already have :)')}>
        ⬇ Download FULL VERSION.exe (FREE, 2.1 GB)
      </button>
    </div>
  );
}

export function Footer({ onToast }: { onToast: (msg: string) => void }) {
  return (
    <footer className="foot">
      <p>
        © 2014–2031 Flippy Wоrk Tаblе LLC ООО. All right reversed. Last update: 31.02.2019.{' '}
        <button type="button" className="link" onClick={() => onToast('Contact form temporary not avialable since 2017. Пожалуйста try later.')}>
          Сontact us
        </button>{' '}
        ·{' '}
        <button type="button" className="link" onClick={() => onToast('Перевод не завершён. Translation is not finish, sorry.')}>
          EN | РУ
        </button>
      </p>
      <p className="lorem">Lorem ipsum dolor sit amet, flippy adipiscing table. TODO: remove this text before launch</p>
      <p className="loading" aria-hidden="true">
        Loading… 99%
      </p>
    </footer>
  );
}
