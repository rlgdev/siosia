// P1 Planned — replaced in T8 by the full schedule (to answer, rides to take, day groups).

import { Page } from "../components/ui";
import { useI18n } from "../i18n";

export function Planned() {
  const { t } = useI18n();
  return (
    <Page title={t("start.planned")} testId="planned">
      <p className="muted">{t("common.loading")}</p>
    </Page>
  );
}
