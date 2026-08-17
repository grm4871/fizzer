/**
 * @file ModalShell.tsx — Shared backdrop + dialog scaffolding for overlay modals.
 *
 * Captures the boilerplate every overlay modal repeated: a backdrop `div` whose
 * `onMouseDown` closes only when the click lands on the backdrop itself, wrapping
 * a `role="dialog" aria-modal="true"` element. The exact class names are preserved
 * per caller because the CSS keys off them.
 *
 * The dialog element is a `<section>` by default; pass `as="form"` (with `onSubmit`)
 * for form-based dialogs. `afterDialog` renders extra nodes inside the backdrop but
 * outside the dialog (e.g. a nested dialog rendered as a sibling).
 */
import { useEffect, type FormEvent, type ReactNode } from 'react';

type ModalShellProps = {
  backdropClassName: string;
  dialogClassName: string;
  onClose: () => void;
  children: ReactNode;
  as?: 'section' | 'form';
  ariaLabel?: string;
  ariaLabelledby?: string;
  onSubmit?: (event: FormEvent) => void;
  afterDialog?: ReactNode;
  /**
   * Whether pressing Escape closes the modal. Defaults to true — every overlay
   * modal repeated the same window keydown listener, so the shell owns it now.
   * Callers that manage their own keydown (e.g. to also restore focus) pass false.
   */
  closeOnEscape?: boolean;
};

export function ModalShell({
  backdropClassName,
  dialogClassName,
  onClose,
  children,
  as = 'section',
  ariaLabel,
  ariaLabelledby,
  onSubmit,
  afterDialog,
  closeOnEscape = true,
}: ModalShellProps) {
  useEffect(() => {
    if (!closeOnEscape) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeOnEscape, onClose]);
  const dialogProps = {
    className: dialogClassName,
    role: 'dialog' as const,
    'aria-modal': true,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledby,
  };
  return (
    <div
      className={backdropClassName}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {as === 'form'
        ? <form {...dialogProps} onSubmit={onSubmit}>{children}</form>
        : <section {...dialogProps}>{children}</section>}
      {afterDialog}
    </div>
  );
}
