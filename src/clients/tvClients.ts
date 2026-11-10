import type {
  IOAuth,
  YouTubeClientContext,
  YouTubeContext
} from '../types/index.ts'
import { BaseClient, type ClientRuntime } from './baseClient.ts'

export class TV extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'TVHTML5', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'TVHTML5',
        clientVersion: '7.20260708.13.02',
        browserVersion: '25.lts.40.1035033-gold',
        browserName: 'Cobalt',
        userAgent:
          'Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) Cobalt/Version (unlike Gecko) v8/11.4.233.17-gold Starboard/16, Tizen;Samsung;KantM_2024;8.0/2300.0 (Samsung, QN90D_98, Wired',
        hl: context.client.hl,
        gl: context.client.gl
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  override getPlayerParams(): string | null {
    return '2AMB'
  }

  override requiresOAuth(): boolean {
    return true
  }

  override requirePlayerScript(): boolean {
    return true
  }
}

export class TV_DOWN extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'TVHTML5', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'TVHTML5',
        clientVersion: '5.20260713',
        browserVersion: '5.150.00-qa',
        browserName: 'Cobalt',
        userAgent:
          'Mozilla/5.0 (Unknown) Cobalt/5.150.00-qa (unlike Gecko) Starboard/3, Unknown;Unknown;Unknown;0/Unknown (Chromium, Starboard, Wired)',
        hl: context.client.hl,
        gl: context.client.gl
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  override getPlayerParams(): string | null {
    return '2AMB'
  }

  override requiresOAuth(): boolean {
    return true
  }

  override requirePlayerScript(): boolean {
    return true
  }
}

export class TVCast extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'TVHTML5_CAST', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'TVHTML5_CAST',
        clientVersion: '7.20190924',
        userAgent:
          'Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 CrKey/1.54.248666',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  override getPlayerParams(): string | null {
    return '2AMB'
  }

  override requirePlayerScript(): boolean {
    return true
  }

  override async getAuthHeaders(): Promise<Record<string, string>> {
    return {}
  }
}

export class TVEmbedded extends BaseClient {
  constructor(runtime: ClientRuntime, oauth: IOAuth | null) {
    super(runtime, 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', oauth)
  }

  override getClient(context: YouTubeContext): YouTubeClientContext {
    return {
      client: {
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        userAgent:
          'Mozilla/5.0 (Linux armeabi-v7a; Android 7.1.2; Fire OS 6.0) Cobalt/22.lts.3.306369-gold (unlike Gecko) v8/8.8.278.8-jit gles Starboard/13, Amazon_ATV_mediatek8695_2019/NS6294 (Amazon, AFTMM, Wireless) com.amazon.firetv.youtube/22.3.r2.v66.0',
        hl: context.client.hl,
        gl: context.client.gl
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
      thirdParty: { embedUrl: 'https://www.youtube.com/tv' }
    }
  }

  override getPlayerParams(): string {
    return '2AMB'
  }

  override isEmbedded(): boolean {
    return true
  }

  override requiresOAuth(): boolean {
    return true
  }

  override requirePlayerScript(): boolean {
    return true
  }
}
