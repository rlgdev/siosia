// MockBackend — the in-browser backend (FR-070). Each instance is one "client" (a user in this tab,
// or a robot driver). Server calls run the shared Engine over localStorage under a Web Lock; effects
// are published on the MockBus exactly like the Supabase functions publish realtime messages.

import { Engine, type EngineConfig } from "../../core/engine";
import type {
  BookingInput,
  ChatMessage,
  ChatRoom,
  ContractInput,
  DeploymentConfig,
  KidInput,
  Leg,
  Place,
  RideTemplateInput,
  ServiceRequestInput,
  DriverPos,
  DriverPresence,
  Lang,
  LatLng,
  RideRequestInput,
  RiderPos,
  Role,
  SharingStop,
  UpdateInput,
  Vehicle
} from "../../core/types";
import type { Backend, DriverPresenceHandle, OfferDecision, PushMessage, RideChannel, RideChannelHandlers, Unsub } from "../types";
import { getBus, type MockBus } from "./bus";
import { withDb } from "./store";

const SERVER_CLIENT = "server";

/** A Blob as a data URL: FileReader in the browser (and jsdom, whose Blob has no arrayBuffer()); bytes elsewhere. */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== "undefined")
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error ?? new Error("read failed"));
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(blob);
    });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  // In chunks: one fromCharCode(...bytes) over a 150 KB photo would exceed the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || "image/jpeg"};base64,${btoa(bin)}`;
}

export const randomKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

export function tabUserId(): string {
  const KEY = "siosia.mock.uid";
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const id = "u-" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    return "u-" + Math.random().toString(36).slice(2, 10);
  }
}

export class MockBackend implements Backend {
  readonly kind = "mock" as const;
  readonly needsInvite: boolean;
  private readonly bus: MockBus;
  private readonly clientId: string;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly uid: string,
    private readonly cfg: EngineConfig,
    opts: { bus?: MockBus; sweep?: boolean } = {}
  ) {
    this.needsInvite = cfg.inviteCode !== null;
    this.bus = opts.bus ?? getBus();
    this.clientId = `${uid}:${Math.random().toString(36).slice(2, 7)}`;
    // Server-side timers (expiry, offer timeouts) — any open tab keeps the mock "server" ticking.
    if (opts.sweep !== false) this.sweeper = setInterval(() => void this.call((e) => e.sweep()).catch(() => {}), 2000);
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  private async call<T>(fn: (e: Engine) => T): Promise<T> {
    let engine: Engine | null = null;
    try {
      return await withDb((db) => {
        engine = new Engine(db, this.cfg, Date.now());
        return fn(engine);
      });
    } finally {
      const fx = (engine as Engine | null)?.effects;
      if (fx) {
        for (const u of fx.notify) this.bus.publish(`user:${u}`, "changed", {}, SERVER_CLIENT);
        for (const p of fx.push)
          this.bus.publish(`user:${p.userId}`, "push", { kind: p.kind, rideId: p.rideId, appointmentId: p.appointmentId ?? null, params: p.params }, SERVER_CLIENT);
        if (fx.pingDrivers) this.bus.publish("drivers", "ping", {}, SERVER_CLIENT);
        // 2.3: a message reaches each party's open thread on their private topic (as Supabase does).
        for (const c of fx.chat) this.bus.publish(`user:${c.userId}`, "chat", { room: c.room, message: c.message }, SERVER_CLIENT);
      }
    }
  }

  async start(): Promise<string> {
    return this.uid;
  }
  async ping(): Promise<void> {}
  async getConfig(): Promise<DeploymentConfig> {
    const { inviteCode: _secret, testInviteCode: _test, masters: _links, ...pub } = this.cfg;
    // Like siosia_config(): the enabled catalog only (appointments carry their entry's name).
    return { ...pub, services: pub.services.filter((e) => e.enabled) };
  }

  isMember(deviceId: string) {
    return this.call((e) => e.isMember(this.uid, deviceId));
  }
  join(code: string, deviceId: string) {
    return this.call((e) => e.join(this.uid, code, deviceId));
  }
  bookRide(input: BookingInput) {
    return this.call((e) => e.bookRide(this.uid, input));
  }
  bookings() {
    return this.call((e) => e.bookings(this.uid));
  }
  openBookings(pos: LatLng | null) {
    return this.call((e) => e.openBookings(this.uid, pos));
  }
  claimBooking(rideId: string) {
    return this.call((e) => e.claimBooking(this.uid, rideId));
  }
  async releaseBooking(rideId: string) {
    await this.call((e) => e.releaseBooking(this.uid, rideId));
  }
  createTransfer() {
    return this.call((e) => e.createTransfer(this.uid));
  }
  redeemTransfer(code: string, deviceId: string, replace = false) {
    return this.call((e) => e.redeemTransfer(this.uid, code, deviceId, replace));
  }
  joinMaster(token: string, deviceId: string, language: Lang, replace = false) {
    return this.call((e) => e.joinMaster(this.uid, token, deviceId, language, replace));
  }
  getProfile() {
    return this.call((e) => e.getProfile(this.uid));
  }
  saveProfile(nickname: string, language: Lang) {
    return this.call((e) => e.saveProfile(this.uid, nickname, language));
  }
  getVehicle() {
    return this.call((e) => e.getVehicle(this.uid));
  }
  saveVehicle(v: Vehicle) {
    return this.call((e) => e.saveVehicle(this.uid, v));
  }
  deleteProfile() {
    return this.call((e) => e.deleteProfile(this.uid));
  }
  myState() {
    return this.call((e) => e.myState(this.uid));
  }
  getRide(rideId: string) {
    return this.call((e) => e.getRide(this.uid, rideId));
  }
  history() {
    return this.call((e) => e.history(this.uid));
  }
  earnings() {
    return this.call((e) => e.earnings(this.uid));
  }
  requestRide(input: RideRequestInput) {
    return this.call((e) => e.requestRide(this.uid, input));
  }
  cancelRide(rideId: string, reason?: string) {
    return this.call((e) => e.cancelRide(this.uid, rideId, reason));
  }
  setOnline(online: boolean) {
    return this.call((e) => e.setOnline(this.uid, online));
  }
  heartbeat(pos: LatLng | null) {
    return this.call((e) => e.heartbeat(this.uid, pos));
  }
  refreshOffers(pos: LatLng) {
    return this.call((e) => e.refreshOffers(this.uid, pos));
  }
  decideOffer(offerId: string, decision: OfferDecision) {
    return this.call((e) => e.decideOffer(this.uid, offerId, decision));
  }
  depart(rideId: string) {
    return this.call((e) => e.depart(this.uid, rideId));
  }
  advance(rideId: string, to: "arrived" | "in_progress" | "completed", actualKm?: number) {
    return this.call((e) => e.advance(this.uid, rideId, to, actualKm));
  }
  markPaid(rideId: string) {
    return this.call((e) => e.markPaid(this.uid, rideId));
  }
  markCollected(rideId: string) {
    return this.call((e) => e.markCollected(this.uid, rideId));
  }
  rate(rideId: string, stars: number, comment: string) {
    return this.call((e) => e.rate(this.uid, rideId, stars, comment));
  }

  // ---------- 2.0 ----------

  catalog() {
    return this.call((e) => e.catalog(this.uid));
  }
  requestService(input: ServiceRequestInput) {
    return this.call((e) => e.requestService(this.uid, input));
  }
  /** 2.1: the Web Lock makes the claim atomic across tabs — the first taker wins. */
  takeRequest(id: string) {
    return this.call((e) => e.takeRequest(this.uid, id));
  }
  setCarColour(colour: string, paint: string) {
    return this.call((e) => e.setCarColour(this.uid, colour, paint));
  }
  answerAppointment(id: string, decision: "accept" | "decline") {
    return this.call((e) => e.answerAppointment(this.uid, id, decision));
  }
  async cancelAppointment(id: string, reason?: string | null, scope: "one" | "series" = "one") {
    await this.call((e) => e.cancelAppointment(this.uid, id, reason, scope));
  }
  getAppointment(id: string) {
    return this.call((e) => e.getAppointment(this.uid, id));
  }
  setRideTemplate(seriesId: string, template: RideTemplateInput) {
    return this.call((e) => e.setRideTemplate(this.uid, seriesId, template));
  }
  async dropRideTemplate(seriesId: string, leg: Leg) {
    await this.call((e) => e.dropRideTemplate(this.uid, seriesId, leg));
  }
  planned() {
    return this.call((e) => e.planned(this.uid));
  }
  timeline() {
    return this.call((e) => e.timeline(this.uid));
  }
  setOffers(ids: string[]) {
    return this.call((e) => e.setOffers(this.uid, ids));
  }
  saveHome(place: Place | null) {
    return this.call((e) => e.saveHome(this.uid, place));
  }
  async rateAppointment(id: string, stars: number, comment: string) {
    await this.call((e) => e.rateAppointment(this.uid, id, stars, comment));
  }

  // ---------- 2.3: kids, photos, chat ----------

  kids() {
    return this.call((e) => e.kids(this.uid));
  }
  addKid(input: KidInput) {
    return this.call((e) => e.addKid(this.uid, input));
  }
  updateKid(id: string, input: KidInput) {
    return this.call((e) => e.updateKid(this.uid, id, input));
  }
  async removeKid(id: string) {
    await this.call((e) => e.removeKid(this.uid, id));
  }
  setAppointmentKids(id: string, kidIds: string[]) {
    return this.call((e) => e.setAppointmentKids(this.uid, id, kidIds));
  }
  async rateKid(appointmentId: string, kidId: string, stars: number, comment: string) {
    await this.call((e) => e.rateKid(this.uid, appointmentId, kidId, stars, comment));
  }
  /** The demo's bucket is the mock database: the JPEG goes in as a data URL, which is also its "signed URL". */
  async setPhoto(target: { kind: "profile" } | { kind: "kid"; id: string }, jpeg: Blob | null) {
    const dataUrl = jpeg ? await blobToDataUrl(jpeg) : null;
    return this.call((e) => e.setPhoto(this.uid, target, dataUrl));
  }
  chat(room: ChatRoom, markRead = false) {
    return this.call((e) => e.chat(this.uid, room, markRead));
  }
  sendMessage(room: ChatRoom, text: string) {
    return this.call((e) => e.sendMessage(this.uid, room, text));
  }
  // ---------- 2.5: session updates and heading home ----------
  updates(appointmentId: string, seen = false) {
    return this.call((e) => e.updates(this.uid, appointmentId, seen));
  }
  async postUpdate(appointmentId: string, input: UpdateInput, jpeg: Blob | null = null) {
    const dataUrl = jpeg ? await blobToDataUrl(jpeg) : null;
    return this.call((e) => e.postUpdate(this.uid, appointmentId, input, dataUrl));
  }
  deleteUpdate(id: string) {
    return this.call((e) => e.deleteUpdate(this.uid, id));
  }
  comingHome(appointmentId: string, minutes: number) {
    return this.call((e) => e.comingHome(this.uid, appointmentId, minutes));
  }

  // ---------- 2.6: family, contracts, cost, weekly reports ----------

  family() {
    return this.call((e) => e.family(this.uid));
  }
  members() {
    return this.call((e) => e.memberList(this.uid));
  }
  inviteToFamily(publicId: string) {
    return this.call((e) => e.inviteToFamily(this.uid, publicId));
  }
  answerInvite(id: string, decision: "join" | "decline") {
    return this.call((e) => e.answerInvite(this.uid, id, decision));
  }
  withdrawInvite(id: string) {
    return this.call((e) => e.withdrawInvite(this.uid, id));
  }
  leaveFamily() {
    return this.call((e) => e.leaveFamily(this.uid));
  }
  contracts() {
    return this.call((e) => e.contracts(this.uid));
  }
  proposeContract(input: ContractInput) {
    return this.call((e) => e.proposeContract(this.uid, input));
  }
  answerContract(id: string, decision: "accept" | "decline") {
    return this.call((e) => e.answerContract(this.uid, id, decision));
  }
  async withdrawContract(id: string) {
    await this.call((e) => e.withdrawContract(this.uid, id));
  }
  async endContract(id: string) {
    await this.call((e) => e.endContract(this.uid, id));
  }
  setActualTime(appointmentId: string, minutes: number) {
    return this.call((e) => e.setActualTime(this.uid, appointmentId, minutes));
  }
  report(week: string | null, scope: "me" | "family") {
    return this.call((e) => e.report(this.uid, week, scope));
  }

  // ---------- realtime ----------

  /** Live messages of one room: both directions, so a second tab of the sender sees them too. */
  onMessage(room: ChatRoom, cb: (m: ChatMessage) => void): Unsub {
    return this.bus.subscribe(`user:${this.uid}`, this.clientId, (event, payload) => {
      const p = payload as { room: ChatRoom; message: ChatMessage };
      if (event === "chat" && p.room === room) cb(p.message);
    });
  }

  onMyChanges(cb: () => void): Unsub {
    return this.bus.subscribe(`user:${this.uid}`, this.clientId, () => cb());
  }

  onPush(cb: (m: PushMessage) => void): Unsub {
    return this.bus.subscribe(`user:${this.uid}`, this.clientId, (event, payload) => {
      if (event === "push") cb(payload as PushMessage);
    });
  }
  async savePush() {
    /* the demo shows its events itself */
  }
  async deletePush() {}

  onDriverPing(cb: () => void): Unsub {
    return this.bus.subscribe("drivers", this.clientId, (event) => {
      if (event === "ping") cb();
    });
  }

  watchDrivers(cb: (drivers: DriverPresence[]) => void): Unsub {
    return this.bus.onPresence("drivers", (state) => cb(Object.values(state) as DriverPresence[]));
  }

  /** Presence under a random key per handle (= per idle period), never the user id. */
  driverPresence(): DriverPresenceHandle {
    const bus = this.bus;
    const key = randomKey();
    const client = this.clientId;
    return {
      track: (p) => bus.track("drivers", key, { ...p, id: key }, client),
      untrack: () => bus.untrack("drivers", key, client),
      close: () => bus.untrack("drivers", key, client)
    };
  }

  openRide(ride: { id: string; round: number }, role: Role, h: RideChannelHandlers): RideChannel {
    const topic = `ride:${ride.id}:${ride.round}`;
    const bus = this.bus;
    const client = this.clientId;
    const unsub = bus.subscribe(topic, client, (event, payload) => {
      if (event === "driver_pos") h.onDriverPos?.(payload as DriverPos);
      else if (event === "rider_pos") h.onRiderPos?.(payload as RiderPos);
      else if (event === "sharing_stop") h.onSharingStop?.(payload as SharingStop);
    });
    const peer = role === "rider" ? "driver" : "rider";
    let lastPeer: boolean | null = null;
    const unsubPres = bus.onPresence(topic, (state) => {
      const present = peer in state;
      if (present !== lastPeer) {
        lastPeer = present;
        h.onPeer?.(present);
      }
    });
    bus.track(topic, role, { role, t: Date.now() }, client);
    return {
      sendDriverPos: (p) => bus.publish(topic, "driver_pos", p, client),
      sendRiderPos: (p) => bus.publish(topic, "rider_pos", p, client),
      sendSharingStop: (p) => bus.publish(topic, "sharing_stop", p, client),
      close: () => {
        unsub();
        unsubPres();
        bus.untrack(topic, role, client);
      }
    };
  }
}
