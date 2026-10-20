// H1 History — replaced in T9 by the merged history with earnings.

import { Page } from "../components/ui";
import { useI18n } from "../i18n";

export function HistoryScreen() {
  const { t } = useI18n();
  return (
    <Page title={t("start.history")} testId="history">
      <p className="muted">{t("common.loading")}</p>
    </Page>
  );
}
