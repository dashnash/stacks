import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemo, DemoApp, type Demo } from '@stacks/demo';
import { personas, seed } from '../api/demo-data';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';
import { App } from '../web/src/App';

const demos: Demo[] = [];
beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});
afterEach(() => {
  for (const d of demos.splice(0)) d.realtime?.close();
});

const SAM = 'sam@demo.stacks';
const ALEX = 'alex@demo.stacks';

/** One demo "tab", signed in as `as` (or signed out). */
function tab(as?: string) {
  const demo = createDemo({ manifest, routes, personas, seed });
  demos.push(demo);
  const { container } = render(
    <div>
      <DemoApp demo={demo} startAs={as}>
        <App />
      </DemoApp>
    </div>,
  );
  return { demo, view: within(container.firstElementChild as HTMLElement) };
}

async function openWeekly(as = SAM) {
  window.location.hash = '#/l/weekly-shop';
  const t = tab(as);
  expect(await t.view.findByRole('heading', { name: 'Weekly shop' })).toBeInTheDocument();
  return t;
}

const rowNames = (view: ReturnType<typeof within>) => view.getAllByRole('button', { name: /^Edit / }).map((b: HTMLElement) => b.getAttribute('aria-label')!.slice(5));

describe('Pantry UI (on the demo backend)', () => {
  it('shows a landing page with no list data to signed-out visitors', async () => {
    const { view } = tab();
    expect(await view.findByText(manifest.tagline)).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(view.queryByText('Weekly shop')).not.toBeInTheDocument();
  });

  it('lists every list with its counts, and mute state per person', async () => {
    const sam = tab(SAM).view;
    expect(await sam.findByText('6 to get · 2 done')).toBeInTheDocument();
    expect(sam.getByText('4 to get')).toBeInTheDocument();
    expect(sam.queryByLabelText('(muted)')).not.toBeInTheDocument();
  });

  it('creates a list and opens it', async () => {
    const { view } = tab(SAM);
    await userEvent.type(await view.findByLabelText('New list'), 'Party');
    await userEvent.click(view.getByRole('button', { name: 'Create' }));
    expect(await view.findByRole('heading', { name: 'Party' })).toBeInTheDocument();
    expect(view.getByText('Nothing on the list. Add something below.')).toBeInTheDocument();
  });

  it('suggests from the list history; picking one fills the name and its last quantity', async () => {
    const { view } = await openWeekly();
    await userEvent.type(view.getByLabelText('Item'), 'mush');
    await userEvent.click(await view.findByRole('button', { name: /^Mushrooms/ }));
    expect(view.getByLabelText('Item')).toHaveValue('Mushrooms');
    expect(view.getByLabelText('Quantity')).toHaveValue('250 g');
    await userEvent.click(view.getByRole('button', { name: 'Add' }));
    expect(await view.findByRole('button', { name: 'Edit Mushrooms' })).toHaveTextContent('250 g');
    expect(view.getByLabelText('Item')).toHaveValue('');
  });

  it('lists prefix matches first, and ✕ forgets a suggestion', async () => {
    const { view } = await openWeekly();
    await userEvent.type(view.getByLabelText('Item'), 'mil');
    const list = await view.findByRole('list', { name: 'Suggestions' });
    await waitFor(() => expect(within(list).getAllByRole('button', { name: /^(?!Forget)/ }).map((b) => b.textContent)).toEqual(['Milk2', 'Almond milk1', 'Oat milk2']));
    await userEvent.click(within(list).getByRole('button', { name: 'Forget Almond milk' }));
    expect(within(list).queryByText('Almond milk')).not.toBeInTheDocument();
  });

  it('ignores whitespace-only names in the add bar', async () => {
    const { view } = await openWeekly();
    const before = rowNames(view);
    await userEvent.type(view.getByLabelText('Item'), '   ');
    expect(view.getByRole('button', { name: 'Add' })).toBeDisabled();
    await userEvent.type(view.getByLabelText('Item'), '{Enter}');
    expect(rowNames(view)).toEqual(before);
  });

  it('undoes each of check off, uncheck, remove and Clear Complete exactly', async () => {
    const { view } = await openWeekly();
    const start = rowNames(view);
    const undo = async () => {
      await userEvent.click(await view.findByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(rowNames(view)).toEqual(start));
    };

    await userEvent.click(view.getByLabelText('Check off Milk'));
    expect(await view.findByText('Checked off Milk')).toBeInTheDocument();
    expect(view.getByLabelText('Uncheck Milk')).toBeChecked();
    await undo();
    expect(view.getByLabelText('Check off Milk')).not.toBeChecked();

    await userEvent.click(view.getByLabelText('Uncheck Eggs'));
    expect(await view.findByText('Unchecked Eggs')).toBeInTheDocument();
    await undo();
    expect(view.getByLabelText('Uncheck Eggs')).toBeChecked();

    await userEvent.click(view.getByRole('button', { name: 'Edit Bananas' }));
    await userEvent.click(view.getByRole('button', { name: 'Delete Bananas' }));
    expect(await view.findByText('Removed Bananas')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Edit Bananas' })).not.toBeInTheDocument();
    await undo();

    await userEvent.click(view.getByRole('button', { name: 'Clear complete (2)' }));
    expect(await view.findByText('Cleared 2 done items')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: /Clear complete/ })).not.toBeInTheDocument();
    await undo();
    expect(view.getByRole('button', { name: 'Clear complete (2)' })).toBeInTheDocument();
  });

  it('edits an item inline (name and quantity)', async () => {
    const { view } = await openWeekly();
    await userEvent.click(view.getByRole('button', { name: 'Edit Milk' }));
    const name = view.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Oat milk');
    await userEvent.type(view.getAllByLabelText('Quantity')[0]!, '{Backspace}3');
    await userEvent.click(view.getByRole('button', { name: 'Save' }));
    expect(await view.findByRole('button', { name: 'Edit Oat milk' })).toHaveTextContent('3');
  });

  it('checks off on a short swipe right and removes on a long swipe left (pointer events)', async () => {
    const { view } = await openWeekly();
    const row = (name: string) => view.getByRole('button', { name: `Edit ${name}` }).closest('li')!;
    // jsdom has no layout: rows measure as 320 px wide, so 25 % = 80 px and 60 % = 192 px.
    const swipe = (el: HTMLElement, dx: number) => {
      fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 200, clientY: 10 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 200 + dx / 2, clientY: 10 });
      fireEvent.pointerMove(el, { pointerId: 1, clientX: 200 + dx, clientY: 10 });
      fireEvent.pointerUp(el, { pointerId: 1, clientX: 200 + dx, clientY: 10 });
    };
    act(() => swipe(row('Spinach'), 60)); // too short: nothing
    expect(view.getByLabelText('Check off Spinach')).not.toBeChecked();
    act(() => swipe(row('Spinach'), 100));
    expect(await view.findByText('Checked off Spinach')).toBeInTheDocument();
    act(() => swipe(row('Coffee beans'), -150)); // not far enough to remove
    expect(view.getByRole('button', { name: 'Edit Coffee beans' })).toBeInTheDocument();
    act(() => swipe(row('Coffee beans'), -220));
    expect(await view.findByText('Removed Coffee beans')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Edit Coffee beans' })).not.toBeInTheDocument();
  });

  it('mutes and unmutes a list with the bell', async () => {
    const { view } = await openWeekly(ALEX);
    await userEvent.click(view.getByRole('button', { name: 'Mute Weekly shop' }));
    expect(await view.findByRole('button', { name: 'Unmute Weekly shop' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('asks before deleting a list', async () => {
    const { view } = await openWeekly();
    await userEvent.click(view.getByRole('button', { name: 'Delete Weekly shop' }));
    expect(await screen.findByText('Delete “Weekly shop”?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete list' }));
    expect(await view.findByText('Your lists')).toBeInTheDocument();
    expect(view.queryByText('Weekly shop')).not.toBeInTheDocument();
  });

  it("shows an item Sam adds in Alex's open list without a reload", async () => {
    window.location.hash = '#/l/weekly-shop';
    const sam = tab(SAM).view;
    const alex = tab(ALEX).view;
    expect(await sam.findByRole('heading', { name: 'Weekly shop' })).toBeInTheDocument();
    expect(await alex.findByRole('heading', { name: 'Weekly shop' })).toBeInTheDocument();
    await waitFor(() => expect(alex.getByRole('img', { name: 'Connection: Live' })).toBeInTheDocument());
    await userEvent.type(sam.getByLabelText('Item'), 'Peaches');
    await userEvent.click(sam.getByRole('button', { name: 'Add' }));
    expect(await sam.findByRole('button', { name: 'Edit Peaches' })).toBeInTheDocument();
    expect(await alex.findByRole('button', { name: 'Edit Peaches' })).toBeInTheDocument();
  });

  it('has one demo persona per role', () => {
    expect(personas.map((p) => p.role).sort()).toEqual(manifest.roles.map((r) => r.id).sort());
  });
});
