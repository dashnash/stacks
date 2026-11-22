import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { runQuery, type PortalApi } from '../src/api';
import { createDemoPortal, DEMO_PEOPLE } from '../src/demo/backend';
import { DEMO_REF } from '../src/demo/monitoring';
import { PortalProvider } from '../src/portal';
import { healthOf, shortResource, zoomWindow } from '../src/views/Monitoring';
import { createHoverSync, LineChart, niceMax } from '../src/views/LineChart';

// StrictMode, as in main.tsx: it runs state updates twice, which catches updates that mutate state.
function renderPortal(hash = '#/') {
  window.location.hash = hash;
  const { api } = createDemoPortal();
  render(
    <StrictMode>
      <PortalProvider api={api} signInMethod={{ kind: 'personas', personas: DEMO_PEOPLE }}>
        <App />
      </PortalProvider>
    </StrictMode>,
  );
  return api;
}

async function signInAs(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`Continue as ${name}`) }));
  await screen.findByRole('button', { name: new RegExp(`Account menu for ${name.split(' ')[0]}`) });
}

async function openMonitoring() {
  renderPortal();
  await signInAs('Dash Nash');
  await userEvent.click(screen.getByRole('link', { name: 'Monitoring' }));
  await screen.findByRole('heading', { name: 'Health' });
}

// jsdom has no PointerEvent: without one, fireEvent's pointer events carry no clientX.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEvent as typeof window.PointerEvent;
}

// jsdom lays nothing out: give every chart the viewBox's size, so a pointer at clientX x is at
// chart unit x (the plot runs from 40 to 512, the whole range).
function layOutCharts() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 520, bottom: 170, width: 520, height: 170, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
}
const charts = () => screen.getAllByRole('img').filter((e) => e.tagName === 'svg');
const pointer = (type: 'pointerMove' | 'pointerDown' | 'pointerUp' | 'pointerLeave', el: Element, clientX: number) => fireEvent[type](el, { clientX, clientY: 50, button: 0, pointerId: 1 });

beforeEach(() => {
  window.location.hash = '#/';
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Monitoring tab', () => {
  it('shows only to platform admins; others get a refusal on the page', async () => {
    renderPortal();
    await signInAs('Priya Rao');
    // Priya manages apps (Access tab) but is not a platform admin.
    expect(screen.getByRole('link', { name: /Access/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Monitoring' })).not.toBeInTheDocument();
    window.location.hash = '#/admin/monitoring';
    expect(await screen.findByText('Platform admins only')).toBeInTheDocument();
  });

  it('refuses the API to anyone but a platform admin', async () => {
    const api = renderPortal();
    await signInAs('Priya Rao');
    await expect(api.monitoringMetrics('24h')).rejects.toMatchObject({ status: 403 });
  });
});

describe('Monitoring page', () => {
  it('shows the health table, the graphs and the log tables', async () => {
    await openMonitoring();
    expect(screen.getByRole('link', { name: 'Monitoring' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Open in CloudWatch/ })).toHaveAttribute('href', expect.stringContaining('#dashboards/dashboard/stacks-demo'));
    const health = screen.getByRole('heading', { name: 'Health' }).nextElementSibling as HTMLElement;
    expect(within(health).getByRole('button', { name: 'platform' })).toBeInTheDocument();
    expect(within(health).getByRole('button', { name: 'mofobookklub' })).toBeInTheDocument();
    for (const title of ['Requests per app', 'Server errors per app (5xx and unhandled)', 'Browser errors per app', 'Request duration per app (p95)', 'Lambda errors and throttles', 'Lambda duration (p95)', 'DynamoDB throttled requests'])
      expect(screen.getByRole('img', { name: title })).toBeInTheDocument();
    const latest = await screen.findByRole('table', { name: 'latestErrors' });
    await waitFor(() => expect(within(latest).getAllByRole('row').length).toBeGreaterThan(1));
    // People are shown by name, never only their id, when the platform knows them.
    expect(within(latest).getAllByRole('button', { name: /Dash|Priya|Sam|Kyle|Joe|Mei|Rex/ }).length).toBeGreaterThan(0);
    expect(await screen.findByRole('table', { name: 'browserErrors' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'slowestRequests' })).toBeInTheDocument();
  });

  it('runs Find by ref from a ref in a table, with the stack trace', async () => {
    await openMonitoring();
    const latest = await screen.findByRole('table', { name: 'latestErrors' });
    await userEvent.click(await within(latest).findByRole('button', { name: DEMO_REF }));
    expect(await screen.findByRole('heading', { name: `Ref ${DEMO_REF}` })).toBeInTheDocument();
    expect(await screen.findByText(/at Router\.handle/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Someone sent you a ref/ })).toHaveValue(DEMO_REF);
  });

  it('asks again when the same ref is looked up again', async () => {
    const api = renderPortal();
    const spy = vi.spyOn(api, 'monitoringQuery');
    await signInAs('Dash Nash');
    window.location.hash = '#/admin/monitoring';
    await screen.findByRole('heading', { name: 'Health' });
    await userEvent.type(screen.getByRole('textbox', { name: /Someone sent you a ref/ }), DEMO_REF);
    const finds = () => spy.mock.calls.filter(([b]) => b.query === 'findByRef').length;
    await userEvent.click(screen.getByRole('button', { name: 'Find by ref' }));
    await screen.findByRole('heading', { name: `Ref ${DEMO_REF}` });
    await waitFor(() => expect(finds()).toBeGreaterThan(0));
    const first = finds();
    await userEvent.click(screen.getByRole('button', { name: 'Find by ref' }));
    await waitFor(() => expect(finds()).toBeGreaterThan(first));
  });

  it('opens and closes a row\'s stack trace on click', async () => {
    await openMonitoring();
    const table = await screen.findByRole('table', { name: 'browserErrors' });
    const row = (await within(table).findAllByRole('row')).find((r) => r.getAttribute('aria-expanded') === 'false')!;
    await userEvent.click(within(row).getAllByRole('cell')[3]!);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(within(table).getByText(/assets\/index-BqT3k9\.js/)).toBeInTheDocument();
    await userEvent.click(within(row).getAllByRole('cell')[3]!);
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it('checks a typed ref before asking', async () => {
    await openMonitoring();
    await userEvent.type(screen.getByRole('textbox', { name: /Someone sent you a ref/ }), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Find by ref' }));
    expect(screen.getByText(/A ref is 8 characters/)).toBeInTheDocument();
  });

  it("shows a person's trail with their name when you click them", async () => {
    await openMonitoring();
    const latest = await screen.findByRole('table', { name: 'latestErrors' });
    const person = (await within(latest).findAllByRole('button', { name: /Dash|Priya|Sam|Kyle|Joe|Mei|Rex/ }))[0]!;
    const name = person.textContent!;
    await userEvent.click(person);
    expect(await screen.findByRole('heading', { name: new RegExp(`${name}'s trail`) })).toBeInTheDocument();
  });

  it('filters to one app from the health table and adds its requests', async () => {
    await openMonitoring();
    await userEvent.click(screen.getByRole('button', { name: 'hello' }));
    expect(screen.getByRole('combobox', { name: 'App' })).toHaveValue('hello');
    expect(await screen.findByRole('heading', { name: 'Requests for hello' })).toBeInTheDocument();
    const reqs = await screen.findByRole('table', { name: 'appRequests' });
    await waitFor(() => expect(within(reqs).getAllByRole('row').length).toBeGreaterThan(1));
    // Clicking it again shows every app.
    await userEvent.click(screen.getByRole('button', { name: 'hello' }));
    expect(screen.getByRole('combobox', { name: 'App' })).toHaveValue('');
  });

  it('draws the hover line at the same time on every graph', async () => {
    await openMonitoring();
    layOutCharts();
    const all = charts();
    expect(all.length).toBe(7);
    pointer('pointerMove', all[0]!, 276);
    for (const c of all) expect(c.querySelector('line.chart-hover')!.getAttribute('x1')).toBe('276');
    // Each graph reads out its own values at that time.
    const readouts = [...document.querySelectorAll('.chart-readout')].map((e) => e.textContent);
    expect(readouts.every((r) => r && r.length > 0)).toBe(true);
    pointer('pointerLeave', all[0]!, 600);
    for (const c of all) expect(c.querySelector('line.chart-hover')).toBeNull();
  });

  it('zooms graphs and health to a window dragged across a graph, and resets', async () => {
    const api = renderPortal();
    const spy = vi.spyOn(api, 'monitoringMetrics');
    await signInAs('Dash Nash');
    await userEvent.click(screen.getByRole('link', { name: 'Monitoring' }));
    await screen.findByRole('heading', { name: 'Health' });
    layOutCharts();
    const before = spy.mock.calls.at(-1)!;
    expect(before).toEqual(['24h', undefined]);
    const [chart] = charts();
    pointer('pointerDown', chart!, 40);
    pointer('pointerMove', chart!, 99);
    expect(screen.getByTestId('chart-select')).toBeInTheDocument();
    pointer('pointerUp', chart!, 99);
    // The time under the pointer is cleared: it would mean another place in the zoomed window.
    for (const c of charts()) expect(c.querySelector('line.chart-hover')).toBeNull();
    // An eighth of the plot (59 of 472 units) of the last 24h: its first 3 hours.
    await waitFor(() => expect(spy.mock.calls.at(-1)![1]).toBeDefined());
    const zoom = spy.mock.calls.at(-1)![1]!;
    expect(zoom.to - zoom.from).toBeCloseTo(3 * 3_600_000, -4);
    expect(await screen.findByText(/^Zoomed:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'false');
    // The demo answers the window at a finer period (1 min for 3 hours, against 5 for 24h), and the page draws it.
    const answer = await spy.mock.results.at(-1)!.value;
    expect(answer).toMatchObject({ range: 'custom', periodSeconds: 60 });
    const firstX = () => [...charts()[0]!.querySelectorAll('text.chart-axis')].map((t) => t.textContent)[3];
    await waitFor(() => expect(firstX()).toBe(new Date(zoom.from).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' })));
    // The tables stay on the preset.
    expect(screen.getByText(/the tables below still cover the last 24h/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    await waitFor(() => expect(spy.mock.calls.at(-1)).toEqual(['24h', undefined]));
    expect(screen.queryByText(/^Zoomed:/)).toBeNull();
  });

  it('treats a click on a graph as a click, not a zoom', async () => {
    const api = renderPortal();
    const spy = vi.spyOn(api, 'monitoringMetrics');
    await signInAs('Dash Nash');
    await userEvent.click(screen.getByRole('link', { name: 'Monitoring' }));
    await screen.findByRole('heading', { name: 'Health' });
    layOutCharts();
    const calls = spy.mock.calls.length;
    const [chart] = charts();
    pointer('pointerDown', chart!, 200);
    pointer('pointerUp', chart!, 202);
    expect(screen.queryByText(/^Zoomed:/)).toBeNull();
    expect(spy.mock.calls.length).toBe(calls);
  });

  it('refreshes every 60 s only while the box is ticked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = renderPortal();
    const spy = vi.spyOn(api, 'monitoringMetrics');
    await signInAs('Dash Nash');
    window.location.hash = '#/admin/monitoring';
    await screen.findByRole('heading', { name: 'Health' });
    const before = spy.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(61_000)));
    expect(spy.mock.calls.length).toBe(before);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Refresh every 60s' }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(61_000)));
    expect(spy.mock.calls.length).toBe(before + 1);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Refresh every 60s' }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(121_000)));
    expect(spy.mock.calls.length).toBe(before + 1);
  });
});

describe('helpers', () => {
  it('polls a running query until it completes, and gives up on a failed one', async () => {
    const answers = [
      { queryId: 'q', status: 'Running' },
      { queryId: 'q', status: 'Complete', rows: [{ route: '/api/me' }], people: {} },
    ];
    const api = { monitoringQuery: vi.fn(async () => answers[0]), monitoringQueryResult: vi.fn(async () => answers[1]) } as unknown as PortalApi;
    expect((await runQuery(api, { query: 'latestErrors', range: '24h' }, { pollMs: 1 })).rows).toEqual([{ route: '/api/me' }]);
    const failed = { monitoringQuery: vi.fn(async () => ({ queryId: 'q', status: 'Failed' })) } as unknown as PortalApi;
    await expect(runQuery(failed, { query: 'latestErrors', range: '24h' })).rejects.toThrow(/ended failed/);
    // Aborted (range or page changed): stops polling.
    const stopped = new AbortController();
    stopped.abort();
    const poll = vi.fn(async () => answers[1]);
    const stop = vi.fn(async () => undefined);
    const running = { monitoringQuery: vi.fn(async () => answers[0]), monitoringQueryResult: poll, stopMonitoringQuery: stop } as unknown as PortalApi;
    await expect(runQuery(running, { query: 'latestErrors', range: '24h' }, { pollMs: 1, signal: stopped.signal })).rejects.toThrow('Stopped');
    expect(poll).not.toHaveBeenCalled();
    // …and stops the query on the server, which runs only so many at once.
    expect(stop).toHaveBeenCalledWith('q');
    // A query that runs past the limit is stopped too.
    const slowStop = vi.fn(async () => undefined);
    const slow = { monitoringQuery: vi.fn(async () => answers[0]), monitoringQueryResult: vi.fn(async () => answers[0]), stopMonitoringQuery: slowStop } as unknown as PortalApi;
    await expect(runQuery(slow, { query: 'latestErrors', range: '24h' }, { pollMs: 1, maxMs: 5 })).rejects.toThrow(/too long/);
    expect(slowStop).toHaveBeenCalledWith('q');
    // …and so is one whose poll fails.
    const failStop = vi.fn(async () => undefined);
    const broken = {
      monitoringQuery: vi.fn(async () => answers[0]),
      monitoringQueryResult: vi.fn(async () => {
        throw new Error('CloudWatch didn\'t answer: ThrottlingException');
      }),
      stopMonitoringQuery: failStop,
    } as unknown as PortalApi;
    await expect(runQuery(broken, { query: 'latestErrors', range: '24h' }, { pollMs: 1 })).rejects.toThrow(/Throttling/);
    expect(failStop).toHaveBeenCalledWith('q');
  });

  it('marks health red for server errors, amber for browser errors or slowness', () => {
    const a = { app: 'x', requests: 10, serverErrors: 0, unhandled: 0, clientErrors: 0, p95Ms: 200 };
    expect(healthOf(a).tone).toBe('ok');
    expect(healthOf({ ...a, unhandled: 1 }).tone).toBe('bad');
    expect(healthOf({ ...a, serverErrors: 1 }).tone).toBe('bad');
    expect(healthOf({ ...a, clientErrors: 2 }).tone).toBe('warn');
    expect(healthOf({ ...a, p95Ms: 1600 }).tone).toBe('warn');
  });

  it('shortens AWS resource names for the legends', () => {
    expect(shortResource('stacks-prod-app-hello-ApiHandler5D2B1F4C-AbCdEf123456 errors', 'prod')).toBe('hello-ApiHandler errors');
    expect(shortResource('stacks-prod-platform-Table8A1B2C3D-1XYZ9ABCDEF0 PutItem', 'prod')).toBe('platform-Table PutItem');
    expect(shortResource('something-else', 'prod')).toBe('something-else');
    // No random suffix: the logical id stays.
    expect(shortResource('stacks-demo-platform-ApiHandler5D2B', 'demo')).toBe('platform-ApiHandler5D2B');
  });

  it('marks a lone point (one error in the range) with a dot, which a path alone would not draw', () => {
    const { container } = render(
      <LineChart title="Errors" from={0} to={3_600_000} periodMs={60_000} series={[{ label: 'club', color: 'red', points: [[600_000, 1], [1_800_000, 2], [1_860_000, 1]] }]} />,
    );
    // The first point stands alone; the other two are joined by the line.
    expect(container.querySelectorAll('circle.chart-dot')).toHaveLength(1);
  });

  it('keeps a zoom window at least 10 minutes long, never past the end nor over 30 days back', () => {
    const end = 100 * 86_400_000;
    const at = { end, now: end };
    expect(zoomWindow(end - 3_600_000, end - 1_800_000, at)).toEqual({ from: end - 3_600_000, to: end - 1_800_000 });
    expect(zoomWindow(end - 3_600_000, end - 3_540_000, at)).toEqual({ from: end - 3_570_000 - 300_000, to: end - 3_570_000 + 300_000 });
    expect(zoomWindow(end - 60_000, end, at)).toEqual({ from: end - 600_000, to: end });
    expect(zoomWindow(end - 32 * 86_400_000, end - 31 * 86_400_000, at)).toEqual({ from: end - 30 * 86_400_000, to: end - 30 * 86_400_000 + 600_000 });
    // A 30d page left open a day: the start is cut to 30 days before now, not before the graphs' end.
    const later = { end, now: end + 86_400_000 };
    expect(zoomWindow(end - 30 * 86_400_000, end - 20 * 86_400_000, later)).toEqual({ from: end - 29 * 86_400_000, to: end - 20 * 86_400_000 });
  });

  it('goes back to the preset with a note when a zoom fails', async () => {
    const api = renderPortal();
    await signInAs('Dash Nash');
    await userEvent.click(screen.getByRole('link', { name: 'Monitoring' }));
    await screen.findByRole('heading', { name: 'Health' });
    layOutCharts();
    const real = api.monitoringMetrics.bind(api);
    vi.spyOn(api, 'monitoringMetrics').mockImplementation((range, window) => (window ? Promise.reject(new Error('CloudWatch did not answer')) : real(range)));
    const [chart] = charts();
    pointer('pointerDown', chart!, 40);
    pointer('pointerMove', chart!, 158);
    pointer('pointerUp', chart!, 158);
    expect(await screen.findByText("Couldn't zoom: CloudWatch did not answer. Showing the preset.")).toBeInTheDocument();
    expect(screen.queryByText(/^Zoomed:/)).toBeNull();
    expect(screen.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back to the preset with one call when the API ignores from/to (a mixed deploy)', async () => {
    const api = renderPortal();
    await signInAs('Dash Nash');
    await userEvent.click(screen.getByRole('link', { name: 'Monitoring' }));
    await screen.findByRole('heading', { name: 'Health' });
    layOutCharts();
    const real = api.monitoringMetrics.bind(api);
    const spy = vi.spyOn(api, 'monitoringMetrics').mockImplementation((range) => real(range));
    const [chart] = charts();
    pointer('pointerDown', chart!, 40);
    pointer('pointerUp', chart!, 99);
    expect(await screen.findByText("This Platform API can't zoom yet; showing the preset.")).toBeInTheDocument();
    expect(screen.queryByText(/^Zoomed:/)).toBeNull();
    await waitFor(() => expect(screen.getByText(/^Updated/)).toBeInTheDocument());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps a zoom that has loaded when a later refresh fails, showing the error', async () => {
    const api = renderPortal();
    await signInAs('Dash Nash');
    await userEvent.click(screen.getByRole('link', { name: 'Monitoring' }));
    await screen.findByRole('heading', { name: 'Health' });
    layOutCharts();
    const spy = vi.spyOn(api, 'monitoringMetrics');
    const [chart] = charts();
    pointer('pointerDown', chart!, 40);
    pointer('pointerUp', chart!, 99);
    await waitFor(() => expect(spy.mock.calls.at(-1)![1]).toBeDefined());
    await spy.mock.results.at(-1)!.value;
    spy.mockRejectedValueOnce(new Error('Network down'));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Network down/)).toBeInTheDocument();
    expect(screen.getByText(/^Zoomed:/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't zoom/)).toBeNull();
  });

  it('clips lines to the plot (a first bucket can start before the range)', () => {
    const { container } = render(<LineChart title="Requests" from={600_000} to={1_200_000} periodMs={60_000} series={[{ label: 'a', color: 'red', points: [[540_000, 1], [600_000, 2], [660_000, 3]] }]} />);
    const id = container.querySelector('clipPath')!.id;
    expect(container.querySelector('path')!.closest('g')!.getAttribute('clip-path')).toBe(`url(#${id})`);
    // A dot on `from` stays whole inside the clip.
    expect(Number(container.querySelector('clipPath rect')!.getAttribute('x'))).toBeLessThanOrEqual(40 - 2.5);
  });

  it('clears the shared hover line when the chart under the pointer stops drawing', () => {
    layOutCharts();
    const sync = createHoverSync();
    const series = [{ label: 'a', color: 'red', points: [[0, 1], [60_000, 2]] as [number, number][] }];
    const { container, rerender } = render(<LineChart title="A" from={0} to={3_600_000} periodMs={60_000} sync={sync} series={series} />);
    pointer('pointerMove', container.querySelector('svg')!, 276);
    expect(sync.get()).not.toBeNull();
    rerender(<LineChart title="A" from={0} to={3_600_000} periodMs={60_000} sync={sync} series={[]} />);
    expect(sync.get()).toBeNull();
  });

  it('shows no readout on a graph without data', () => {
    const sync = createHoverSync();
    const { container } = render(<LineChart title="Empty" from={0} to={3_600_000} periodMs={60_000} sync={sync} series={[]} />);
    act(() => sync.set(60_000));
    expect(container.querySelector('.chart-readout')!.textContent).toBe('');
  });

  it('shares the hover time between charts given one sync, and keeps it inside each range', () => {
    const sync = createHoverSync();
    const { container } = render(
      <>
        <LineChart title="A" from={0} to={3_600_000} periodMs={60_000} sync={sync} series={[{ label: 'a', color: 'red', points: [[0, 1], [60_000, 2]] }]} />
        <LineChart title="B" from={0} to={3_600_000} periodMs={60_000} sync={sync} series={[{ label: 'b', color: 'blue', points: [[0, 3], [60_000, 4]] }]} />
        <LineChart title="C" from={7_200_000} to={9_000_000} periodMs={60_000} sync={sync} series={[{ label: 'c', color: 'green', points: [[7_200_000, 1]] }]} />
      </>,
    );
    act(() => sync.set(60_000));
    expect(container.querySelectorAll('line.chart-hover')).toHaveLength(2);
    expect(screen.getByText(/b 4/)).toBeInTheDocument();
    act(() => sync.set(null));
    expect(container.querySelectorAll('line.chart-hover')).toHaveLength(0);
  });

  it('rounds chart maxima up to 1, 2 or 5 times a power of ten', () => {
    expect([0, 0.4, 3, 7, 12, 480, 1001].map(niceMax)).toEqual([1, 0.5, 5, 10, 20, 500, 2000]);
  });
});
