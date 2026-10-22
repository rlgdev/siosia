// Profile icon (master profiles) and the "master profile" chip shown to its riders.
// 2.1 (FR-170, V38): a car icon is drawn in the vehicle's paint; the user's own car icon is a
// button that opens the car colours, and riders see the driver's car in its paint.
// 2.3 (FR-211): a photo, when the viewer may see it, goes wherever the nickname is shown; the
// icon stays as the fallback (Avatar).

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Profile, Vehicle } from "../core/types";
import { useI18n } from "../i18n";
import { useApp, useStore } from "../state/store";
import { CAR_PAINTS, DEFAULT_PAINT, iconLabel, iconSvg, isCarIcon, normalPaint, PLAIN_CAR, profileIcon, type CarPaint } from "./profileIcons";
import { Money, useBusy } from "./ui";

type Size = "sm" | "md" | "lg";

export function ProfileIcon({ icon, size = "md", paint }: { icon: string | null | undefined; size?: Size; paint?: string | null }) {
  const { lang } = useI18n();
  const def = profileIcon(icon);
  if (!def) return null;
  const label = iconLabel(def, paint, lang);
  return (
    <span
      className={`profile-icon profile-icon-${size}`}
      role="img"
      aria-label={label}
      title={label}
      data-testid="profile-icon"
      data-paint={def.car ? (normalPaint(paint) ?? DEFAULT_PAINT) : undefined}
      dangerouslySetInnerHTML={{ __html: iconSvg(def, paint) }}
    />
  );
}

/**
 * A person or a kid next to their name (FR-211): the photo (a signed URL the server issued to this
 * viewer) first, else the profile icon in its paint, else `fallback` (an initial, or nothing).
 * The image has no alt: the name sits right next to it. A photo that does not load — its signed
 * URL expired while the app stayed open (C16) — gives way to the icon until a fresh URL arrives.
 */
export function Avatar({
  photo,
  icon,
  paint,
  size = "sm",
  fallback = null,
  testId = "avatar-photo"
}: {
  photo?: string | null;
  icon?: string | null;
  paint?: string | null;
  size?: Size;
  fallback?: ReactNode;
  testId?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  if (photo && broken !== photo) return <img className={`avatar-photo avatar-photo-${size}`} src={photo} alt="" onError={() => setBroken(photo)} data-testid={testId} />;
  if (profileIcon(icon)) return <ProfileIcon icon={icon} size={size} paint={paint} />;
  return <>{fallback}</>;
}

/** The first letter of a name in a round badge: the placeholder of the v1 driver card. */
export function Initial({ name }: { name: string }) {
  return (
    <div className="avatar" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

/** The user's own car icon when the profile's icon is a car and the profile may drive (FR-170). */
export function ownCarIcon(p: Profile | null | undefined): string | null {
  return p && p.masterRole !== "rider" && isCarIcon(p.icon) ? p.icon : null;
}

/** The paint of the user's own car: the vehicle's, else the master profile's preset. */
export function ownPaint(vehicle: Vehicle | null, p: Profile | null | undefined): string | null {
  return normalPaint(vehicle?.paint) ?? normalPaint(p?.masterVehicle?.paint);
}

/** The user's own car icon as a button: a tap offers the car colours (FR-170). */
export function CarIconButton({ icon, size = "md" }: { icon: string; size?: Size }) {
  const { t } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="car-icon-btn" aria-label={t("car.change")} title={t("car.change")} onClick={() => setOpen(true)} data-testid="car-icon">
        <ProfileIcon icon={icon} size={size} paint={ownPaint(app.vehicle, app.profile)} />
      </button>
      {/* Over everything, also when the icon sits in a map sheet. */}
      {open && createPortal(<CarColourSheet onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

/** "Car colour": the ten colours; choosing one names the colour in the user's language (V38). */
export function CarColourSheet({ onClose }: { onClose: () => void }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const store = useStore();
  const [busy, run, error] = useBusy();
  const current = normalPaint(app.vehicle?.paint);
  const choose = (p: CarPaint) =>
    run(async () => {
      await store.setCarColour(p.name[lang], p.hex);
      onClose();
    });
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal stack" role="dialog" aria-modal="true" aria-label={t("car.title")} onClick={(e) => e.stopPropagation()} data-testid="car-colours">
        <h3>{t("car.title")}</h3>
        {app.vehicle ? (
          <div className="swatches" role="group" aria-label={t("car.title")}>
            {CAR_PAINTS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="swatch"
                aria-pressed={current === p.hex}
                disabled={busy}
                onClick={() => void choose(p)}
                data-testid={`paint-${p.id}`}
              >
                <span className="swatch-dot" style={{ background: p.hex }} aria-hidden="true" />
                <span>{p.name[lang]}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="stack" data-testid="car-none">
            <p>{t("car.addFirst")}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                onClose();
                store.openPanel("vehicle");
              }}
              data-testid="car-add"
            >
              {t("car.add")}
            </button>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={onClose} autoFocus>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A driver as riders see them (driver card, booking card): their photo (2.3), else the profile
 * icon, or a plain car once the car has a paint, drawn in that paint — the party's paint (sent
 * with every party), else the assigned vehicle's; `fallback` otherwise.
 */
export function DriverIcon({
  driver,
  size = "sm",
  fallback = null
}: {
  driver: { icon?: string | null; paint?: string | null; photo?: string | null; vehicle?: Vehicle | null };
  size?: Size;
  fallback?: ReactNode;
}) {
  if (driver.photo) return <Avatar photo={driver.photo} size={size} />;
  const paint = normalPaint(driver.paint) ?? normalPaint(driver.vehicle?.paint);
  const icon = profileIcon(driver.icon) ? driver.icon : paint ? PLAIN_CAR : null;
  if (!icon) return <>{fallback}</>;
  return <ProfileIcon icon={icon} size={size} paint={paint} />;
}

/** "Roman · Master profile · every ride: 18,00 zł" — only for a device that uses a master profile. */
export function MasterChip() {
  const { t } = useI18n();
  const app = useApp();
  const p = app.profile;
  if (!p?.masterId) return null;
  const car = ownCarIcon(p);
  return (
    <div className="master-chip" data-testid="master-chip">
      {car ? <CarIconButton icon={car} /> : <ProfileIcon icon={p.icon} size="md" />}
      <div>
        <strong>{p.nickname}</strong>
        <span className="muted small">
          {t("master.badge")}
          {p.fixedFare !== null && app.deployment && (
            <>
              {" · "}
              {t("master.everyRide")} <Money amount={p.fixedFare} currency={app.deployment.tariff.currency} />
            </>
          )}
        </span>
      </div>
    </div>
  );
}
