// Profile icon (master profiles) and the "master profile" chip shown to its riders.

import { useI18n } from "../i18n";
import { useApp } from "../state/store";
import { profileIcon } from "./profileIcons";
import { Money } from "./ui";

export function ProfileIcon({ icon, size = "md" }: { icon: string | null | undefined; size?: "sm" | "md" | "lg" }) {
  const { lang } = useI18n();
  const def = profileIcon(icon);
  if (!def) return null;
  return (
    <span
      className={`profile-icon profile-icon-${size}`}
      role="img"
      aria-label={def.label[lang]}
      title={def.label[lang]}
      data-testid="profile-icon"
      dangerouslySetInnerHTML={{ __html: def.svg }}
    />
  );
}

/** "Roman · Master profile · every ride: 18,00 zł" — only for a device that uses a master profile. */
export function MasterChip() {
  const { t } = useI18n();
  const app = useApp();
  const p = app.profile;
  if (!p?.masterId) return null;
  return (
    <div className="master-chip" data-testid="master-chip">
      <ProfileIcon icon={p.icon} size="md" />
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
