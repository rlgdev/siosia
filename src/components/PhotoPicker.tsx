// A photo for the profile or one of my kids (FR-210): picked from the phone's camera or gallery,
// resized here (≤ 512 px on the long side, JPEG ≤ 150 KB) before it leaves the phone, then stored
// by the backend, which hands back short-lived signed URLs (FR-212). Remove deletes the object.

import { useRef, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { useStore } from "../state/store";
import { resizeToJpeg } from "./photo";
import { useBusy } from "./ui";

export type PhotoTarget = { kind: "profile" } | { kind: "kid"; id: string };

export function PhotoPicker({
  target,
  current,
  onChanged,
  testId,
  children
}: {
  target: PhotoTarget;
  /** The current photo (a signed URL), or null. */
  current: string | null;
  /** Reloads whatever shows the photo. */
  onChanged: () => void | Promise<void>;
  testId: string;
  /** What the photo belongs to (the avatar and the name), shown next to the buttons. */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const store = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [busy, run, error, setError] = useBusy();

  const pick = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      // A picture the browser cannot decode (or no picture at all) is refused here, not uploaded.
      const jpeg = await resizeToJpeg(file).catch(() => null);
      if (!jpeg) {
        setError(t("photo.failed"));
        return;
      }
      await store.api.setPhoto(target, jpeg);
      await onChanged();
    });
  };

  const remove = () =>
    run(async () => {
      await store.api.setPhoto(target, null);
      await onChanged();
    });

  return (
    <div className="photo-picker row wrap" data-testid={testId}>
      {children}
      {/* No `capture`: with it iOS and Android open the camera only; accept="image/*" alone gives
          the camera-or-gallery sheet (C3, C7). */}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          pick(e.target.files?.[0]);
          // The same file picked again must fire change again.
          e.target.value = "";
        }}
        data-testid={`${testId}-file`}
      />
      <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={() => input.current?.click()} data-testid={`${testId}-pick`}>
        {t(current ? "photo.change" : "photo.add")}
      </button>
      {current && (
        <button type="button" className="btn btn-link btn-small" disabled={busy} onClick={() => void remove()} data-testid={`${testId}-remove`}>
          {t("photo.remove")}
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
