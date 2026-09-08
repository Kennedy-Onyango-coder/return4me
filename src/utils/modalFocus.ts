/** Trap keyboard focus while retaining native navigation between dialog controls. */
export function trapModalFocus(event: KeyboardEvent, dialog: HTMLElement) {
  if (event.key !== 'Tab') return;
  const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [tabindex]',
  )).filter(el => el.tabIndex >= 0 && !el.matches(':disabled') &&
    !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = dialog.ownerDocument.activeElement;
  if (!first) {
    event.preventDefault();
    dialog.focus();
  } else if (!controls.includes(active as HTMLElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}