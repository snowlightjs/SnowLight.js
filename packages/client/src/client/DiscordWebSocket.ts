import WebSocket from 'ws'
import { TypedEmitter } from 'tiny-typed-emitter'
import { GatewayOpcodes } from 'discord-api-types/v10'
import { Client } from './Client'
import { DiscordSetPresence, EventBuilder } from '../types/Types'
import fs from "fs"
import path from 'path'
export class DiscordWebSocket extends TypedEmitter<ShardEvents> {
    public ws: WebSocket | null = null
    public lasttimeHeartbeat: number = 0
    public start_time: Date = new Date()
    public client: Client
    public sessionId: string | null = null
    public client_id: string | null = null
    public sequenceNumber: number | null = null
    public ping: number = -1
    public isReconnect: boolean = false
    public isReady: boolean = false
    public isPayloadReady: boolean = false
    public timeout_ready_emit: NodeJS.Timeout | null = null
    public cache: Map<string, any> = new Map()
    public url: string = 'wss://gateway.discord.gg/?v=10&encoding=json'
    constructor(readonly id: number, client: Client) {
        super()
        this.client = client
        this._init_();
    }

    private async _init_() {
        try {
            const [EventFolder] = await Promise.all([
                fs.readdirSync(path.join(__dirname, "./events")),
            ]);
            for (const folder of EventFolder) {
                const commandsInFolder = fs.readdirSync(path.join(__dirname, `./events/${folder}`));
                for (const commandFile of commandsInFolder) {
                    const command: EventBuilder = await import(`./events/${folder}/${commandFile}`).then((c) => c.default);
                    this.cache.set(command.name, command);
                    this.debug(`Loaded Events: ${command.name.toString()}[${commandFile}]`);
                }
            }
        } catch (e) {
            this.debug(`Error: ${e}`);
            process.exit(1)
        }
    }
    /*
    * Get uptime of shard
    */
    public get uptime(): number {
        return process.uptime() * 1000;
    }

    public async connect() {
        if (this.client.options.token === null === undefined) {
            return this.debug('Token is not defined')
        }
        const ws = new WebSocket(this.url)
        this.ws = ws
        this.debug("Connecting to Discord Gateway: " + this.url)
        ws.on('open', this.onOpen.bind(this))
        ws.on('message', this.onMessage.bind(this))
        ws.on('close', (code: number, reason: string) => this.onClose(code, reason))
        ws.on('error', this.onError.bind(this))
    }

    public async disconnect(reason?: string) {
        await this.client.stopInterval(this.id);
        this.debug(`Disconnecting from Discord Gateway with reason ${reason}`)
        this.ws?.close(1000, 'Disconnecting');
    }
    private onOpen() {
        if (this.ws === null) {
            return this.debug('WebSocket is not defined')
        }
    }

    private async onMessage(packets: string) {
        const payload = JSON.parse(packets)
        this.emit('raw', payload)
        switch (payload.op) {
            case GatewayOpcodes.Hello:
                this.client.cache.set((this.id).toString(), setInterval(() => {
                    this.send({ op: GatewayOpcodes.Heartbeat, d: this.sequenceNumber })
                    this.lasttimeHeartbeat = Date.now()
                }, payload.d.heartbeat_interval))
                if (this.sessionId !== null && this.sequenceNumber !== null) { this.resume() } else { this.identify() }
                break;
            case GatewayOpcodes.HeartbeatAck:
                this.ping = Date.now() - this.lasttimeHeartbeat;
                this.debug(`Received HeartbeatAck with ping ${this.ping}`)
                break;
            case GatewayOpcodes.InvalidSession:
                this.debug(`Received InvalidSession`)
                this.sessionId = null
                this.sequenceNumber = null
                this.reconnect();
                if (payload.d === true) { this.resume() } else { this.reconnect() }
                break;
            case GatewayOpcodes.Reconnect:
                this.debug(`Received Reconnect Gateway`)
                this.reconnect();
                break;
            case GatewayOpcodes.Dispatch:
                try {
                    let events: EventBuilder = this.cache.get(payload.t);
                    if (!events) return;
                    await events.run(payload, this, this.client);
                } catch (error) { }
                break;
            default:
                if (process.env.NODE_ENV === 'development') {
                    this.debug(`Received unknown Gateway with opcode ${payload.op}`)
                } else return;
        }
    }

    public resume() {
        this.debug(`Resuming with Gateway`)
        this.send({
            op: GatewayOpcodes.Resume,
            d: { token: this.client.options.token, session_id: this.sessionId, seq: this.sequenceNumber }
        })
    }

    private async onClose(code: number, reason: string) {
        await this.client.stopInterval(this.id);
        this.ping = -1
        this.isReady = false
        this.debug(`Disconnected from Discord Gateway with code ${code} and reason ${reason}`);
        this.connect()
    }

    private onError(error: Error) {
        this.debug(`Error: ${error}`);
    }

    public send(payload: Dictionary) {
        if (this.ws === null) return
        const raw = JSON.stringify(payload)
        this.ws.send(raw);
    }

    private async reconnect() {
        await this.client.stopInterval(this.id);
        this.ping = -1
        this.ws?.close(4000, 'Reconnecting')
    }

    public async setPresence(options: DiscordSetPresence) {
        const { name, type, url } = options;
        this.debug(`Setting presence to ${name} with status ${options.status} and type ${type} and url ${url}`)
        this.send({
            op: GatewayOpcodes.PresenceUpdate,
            d: {
                since: 91879201,
                activities: [{ name, type, url }],
                status: options.status,
                afk: false,
            },
        })
    }

    public async identify() {
        const { token, intents, presence } = this.client.options;
        const { status, activities } = presence;
        const { name, type, url } = activities;
        this.debug(`Identifying with Gateway`);
        this.send({
            op: GatewayOpcodes.Identify,
            d: {
                token,
                intents,
                properties: { $os: process.platform, $browser: "LiquidLight", $device: `LiquidLight@${((await import("../../package.json")).version)}` },
                compress: false,
                large_threshold: 50,
                shard: [this.id, this.client.options.shard.shardCount],
                presence: {
                    status,
                    activities: [
                        {
                            name,
                            url,
                            type
                        }
                    ]
                },
            },
        })
    }

    Ready() {
        if (this.timeout_ready_emit) clearTimeout(this.timeout_ready_emit)
        //@ts-ignore
        this.timeout_ready_emit = setTimeout(() => {
            this.isPayloadReady = true
            this.emit('ready');
        }, 1500)
    }

    public debug(message: string) {
        this.emit('debug', `[Socket][${this.id}] -> ${JSON.stringify(message)}`)
    }
}
export declare interface ShardEvents {
    debug: (message: string) => void
    raw: (message: string) => void
    ready: () => void
}

export declare type Dictionary<V = any, K extends string | symbol = string> = Record<K, V>;