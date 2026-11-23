"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    spark: (
      <>
        <path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z" />
        <path d="m20 2 .7 2.3L23 5l-2.3.7L20 8l-.7-2.3L17 5l2.3-.7L20 2Z" />
      </>
    ),
    chat: (
      <>
        <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z" />
        <path d="M7 10h9M7 14h6" />
      </>
    ),
    arrow: (
      <>
        <path d="M4 12h15m-6-6 6 6-6 6" />
      </>
    ),
    back: <path d="m14 5-7 7 7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="3" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    send: (
      <>
        <path d="m21 3-7 18-4-8-8-4L21 3Z" />
        <path d="m10 13 11-10" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v.3" />
      </>
    ),
    leaf: (
      <>
        <path d="M20 3c1 11-4 18-12 15C0 15 5 4 20 3Z" />
        <path d="m5 21 10-12" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M5 8a8 8 0 0 1 14-2l1 6M4 12l1 6a8 8 0 0 0 14-2" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.spark}
    </svg>
  );
}

export function Avatar({
  name,
  tone = "rose",
  small = false,
}: {
  name: string;
  tone?: string;
  small?: boolean;
}) {
  return (
    <div
      className={`avatar ${tone} ${small ? "small" : ""}`}
      aria-hidden="true"
    >
      <span className="avatar-orbit" />
      <span className="avatar-dot" />
      <span className="avatar-letter">{name.slice(0, 1)}</span>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <button
          className="icon-button modal-close"
          onClick={onClose}
          aria-label="닫기"
        >
          <Icon name="close" />
        </button>
        {children}
      </div>
    </dialog>
  );
}

export function Busy({ text = "잠시만 기다려주세요" }: { text?: string }) {
  return (
    <span className="busy" role="status">
      <span className="spinner" />
      {text}
    </span>
  );
}
