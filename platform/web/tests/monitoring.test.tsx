import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { runQuery, type PortalApi } from '../src/api';
import { createDemoPortal, DEMO_PEOPLE } from '../src/demo/backend';
import { DEMO_REF } from '../src/demo/monitoring';
import { PortalProvider } from '../src/portal';
import { healthOf, shortResource } from '../src/views/Monitoring';
import { LineChart, niceMax } from '../src/views/LineChart';

function renderPortal(hash = '#/') {
  window.location.hash = hash;
  const { api } = createDemoPortal();
  render(
    <PortalProvider api={api} signInMethod={{ kind: 'personas', personas: DEMO_PEOPLE }}>
      <App />
    </PortalProvider>,
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

beforeEach(() => {
  window.location.hash = '#/';
});
afterEach(() => {
  vi.useRealTimers();
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

  it('checks a typed ref before asking', async () => {
    await openMonitoring();
    await userEvent.type(screen.getByRole('textbox', { name: /Someone sent you a ref/ }), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Find by ref' }));
    expect(screen.getByText(/A ref is 8 letters and digits/)).toBeInTheDocument();
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
  });

  it('marks health red for server errors, amber for browser errors or slowness', () => {
    const a = { app: 'x', requests: 10, serverErrors: 0, unhandled: 0, clientErrors: 0, p95Ms: 200 };
    expect(healthOf(a).tone).toBe('ok');
    expect(healthOf({ ...a, unhandled: 1 }).tone).toBe('bad');
    expect(healthOf({ ...a, clientErrors: 2 }).tone).toBe('warn');
    expect(healthOf({ ...a, p95Ms: 1600 }).tone).toBe('warn');
  });

  it('shortens AWS resource names for the legends', () => {
    expect(shortResource('stacks-prod-app-hello-ApiHandler5D2B1F4C-AbCdEf123456 errors', 'prod')).toBe('hello-ApiHandler errors');
    expect(shortResource('stacks-prod-platform-Table8A1B2C3D-1XYZ9ABCDEF0 PutItem', 'prod')).toBe('platform-Table PutItem');
    expect(shortResource('something-else', 'prod')).toBe('something-else');
  });

  it('marks a lone point (one error in the range) with a dot, which a path alone would not draw', () => {
    const { container } = render(
      <LineChart title="Errors" from={0} to={3_600_000} periodMs={60_000} series={[{ label: 'club', color: 'red', points: [[600_000, 1], [1_800_000, 2], [1_860_000, 1]] }]} />,
    );
    // The first point stands alone; the other two are joined by the line.
    expect(container.querySelectorAll('circle.chart-dot')).toHaveLength(1);
  });

  it('rounds chart maxima up to 1, 2 or 5 times a power of ten', () => {
    expect([0, 0.4, 3, 7, 12, 480, 1001].map(niceMax)).toEqual([1, 0.5, 5, 10, 20, 500, 2000]);
  });
});
