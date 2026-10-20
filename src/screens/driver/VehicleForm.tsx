// D6 Vehicle profile (FR-004): required before a driver can go online; editable later.

import { useState, type ChangeEvent, type FormEvent } from "react";
import { Panel, useBusy } from "../../components/ui";
import type { Vehicle } from "../../core/types";
import { useI18n } from "../../i18n";
import { useApp, useStore } from "../../state/store";

export function VehicleForm({ onSaved }: { onSaved?: () => void }) {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const preset = app.profile?.masterVehicle;
  const [v, setV] = useState<Vehicle>(
    app.vehicle ?? (preset ? { ...preset, plate: preset.plate ?? "" } : { make: "", model: "", colour: "", plate: "", seats: 4 })
  );
  const [busy, run, error] = useBusy();
  const set = (k: keyof Vehicle) => (e: ChangeEvent<HTMLInputElement>) =>
    setV({ ...v, [k]: k === "seats" ? Number(e.target.value) : e.target.value });
  const valid = v.make.trim() && v.model.trim() && v.colour.trim() && v.plate.trim().length >= 2 && v.seats >= 1 && v.seats <= 6;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await store.saveVehicle(v);
      onSaved?.();
    });
  };
  return (
    <form className="stack" onSubmit={submit} data-testid="vehicle-form">
      <p className="muted">{t("vehicle.intro")}</p>
      <label className="field">
        <span>{t("vehicle.make")}</span>
        <input value={v.make} onChange={set("make")} maxLength={30} required />
      </label>
      <label className="field">
        <span>{t("vehicle.model")}</span>
        <input value={v.model} onChange={set("model")} maxLength={30} required />
      </label>
      <label className="field">
        <span>{t("vehicle.colour")}</span>
        <input value={v.colour} onChange={set("colour")} maxLength={20} required />
      </label>
      <div className="row">
        <label className="field grow">
          <span>{t("vehicle.plate")}</span>
          <input value={v.plate} onChange={set("plate")} maxLength={12} required autoCapitalize="characters" />
        </label>
        <label className="field narrow">
          <span>{t("vehicle.seats")}</span>
          <input type="number" min={1} max={6} value={v.seats} onChange={set("seats")} required />
        </label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !valid}>
        {t("common.save")}
      </button>
    </form>
  );
}

export function VehiclePanel() {
  const { t } = useI18n();
  const store = useStore();
  return (
    <Panel title={t("vehicle.title")} onClose={() => store.closePanel()}>
      <VehicleForm onSaved={() => store.closePanel()} />
    </Panel>
  );
}

/** First entry into Drive asks for the vehicle (§3 step 3). */
export function VehicleSetup() {
  const { t } = useI18n();
  const store = useStore();
  return (
    <main className="center-screen">
      <h1>{t("vehicle.title")}</h1>
      <VehicleForm />
      <button type="button" className="btn btn-link" onClick={() => store.home()}>
        {t("common.back")}
      </button>
    </main>
  );
}
