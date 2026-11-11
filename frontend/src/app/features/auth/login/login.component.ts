import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/auth.service';

type Foco = 'ninguno' | 'usuario' | 'clave';

interface IconoOrbita {
  id: string;
  etiqueta: string;
  angulo: number;
  tono: 'azul' | 'rojo';
  retraso: number;
  trazos: string[];
}

@Component({
  selector: 'app-login',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page">
      <!-- Fondo animado -->
      <div class="bg" aria-hidden="true">
        <span class="orb orb-blue"></span>
        <span class="orb orb-red"></span>
        <span class="orb orb-blue2"></span>
        <span class="grid"></span>
      </div>

      <section class="shell">
        <!-- Panel de marca + bot + iconos en órbita -->
        <aside class="brand">
          <div class="brand-top">
            <svg class="shield" viewBox="0 0 64 72" aria-hidden="true">
              <defs>
                <linearGradient id="gShield" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#3b82f6" />
                  <stop offset="1" stop-color="#1e3a8a" />
                </linearGradient>
                <linearGradient id="gShieldR" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#fb7185" />
                  <stop offset="1" stop-color="#be123c" />
                </linearGradient>
              </defs>
              <path d="M32 3 59 13v22c0 17-12 29-27 34C17 64 5 52 5 35V13Z" fill="url(#gShield)" />
              <path d="M32 3 59 13v22c0 17-12 29-27 34Z" fill="url(#gShieldR)" opacity=".55" />
              <path d="M32 50V24m0 0-9 10m9-10 9 10" fill="none" stroke="#fff" stroke-width="5"
                    stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <div class="brand-name">GRUPO <b>RPC</b></div>
          </div>

          <div class="bubble" [class.bubble-alert]="!!error()" aria-live="polite">
            <span class="bubble-text" [attr.data-k]="mensaje()">{{ mensaje() }}</span>
          </div>

          <div class="stage">
            <span class="halo" aria-hidden="true"></span>
            <span class="ring ring1" aria-hidden="true"></span>
            <span class="ring ring2" aria-hidden="true"></span>

            <!-- Órbita interior -->
            <div class="orbit o1" aria-hidden="true">
              @for (i of anillo1; track i.id) {
                <div class="slot" [style.--a]="i.angulo + 'deg'">
                  <div class="chip" [class.tone-b]="i.tono === 'azul'" [class.tone-r]="i.tono === 'rojo'"
                       [attr.data-l]="i.etiqueta">
                    <div class="chip-in" [style.animation-delay]="i.retraso + 's'">
                      <svg viewBox="0 0 24 24" class="i">
                        @for (t of i.trazos; track t) { <path [attr.d]="t" /> }
                      </svg>
                    </div>
                  </div>
                </div>
              }
            </div>

            <!-- Órbita exterior -->
            <div class="orbit o2" aria-hidden="true">
              @for (i of anillo2; track i.id) {
                <div class="slot" [style.--a]="i.angulo + 'deg'">
                  <div class="chip" [class.tone-b]="i.tono === 'azul'" [class.tone-r]="i.tono === 'rojo'"
                       [attr.data-l]="i.etiqueta">
                    <div class="chip-in" [style.animation-delay]="i.retraso + 's'">
                      <svg viewBox="0 0 24 24" class="i">
                        @for (t of i.trazos; track t) { <path [attr.d]="t" /> }
                      </svg>
                    </div>
                  </div>
                </div>
              }
            </div>

            <!-- Robot asistente -->
            <svg class="bot" [class.cover]="tapando()" [class.sad]="!!error()" [class.busy]="cargando()"
                 viewBox="0 0 220 262" role="img" aria-label="Asistente virtual de Grupo RPC">
              <defs>
                <radialGradient id="rgWhite" cx=".32" cy=".25" r=".95">
                  <stop offset="0" stop-color="#ffffff" />
                  <stop offset=".35" stop-color="#f0f4fc" />
                  <stop offset=".75" stop-color="#cbd8ef" />
                  <stop offset="1" stop-color="#9db0d4" />
                </radialGradient>
                <radialGradient id="rgBlue" cx=".3" cy=".25" r=".95">
                  <stop offset="0" stop-color="#8bbcff" />
                  <stop offset=".4" stop-color="#2f6bf0" />
                  <stop offset=".8" stop-color="#1b3fb0" />
                  <stop offset="1" stop-color="#0f2468" />
                </radialGradient>
                <radialGradient id="rgRed" cx=".3" cy=".25" r=".95">
                  <stop offset="0" stop-color="#ff93a8" />
                  <stop offset=".5" stop-color="#e11d48" />
                  <stop offset="1" stop-color="#8f0f2e" />
                </radialGradient>
                <linearGradient id="lgVisor" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="#1f3478" />
                  <stop offset=".5" stop-color="#0a1230" />
                  <stop offset="1" stop-color="#030612" />
                </linearGradient>
                <linearGradient id="lgShade" x1="0" y1="0" x2="0" y2="1">
                  <stop offset=".45" stop-color="#1e3a8a" stop-opacity="0" />
                  <stop offset="1" stop-color="#1e3a8a" stop-opacity=".32" />
                </linearGradient>
                <linearGradient id="lgMetal" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stop-color="#1c2745" />
                  <stop offset=".5" stop-color="#7a8bb0" />
                  <stop offset="1" stop-color="#1c2745" />
                </linearGradient>
                <linearGradient id="lgArm" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stop-color="#a9b8d6" />
                  <stop offset=".45" stop-color="#ffffff" />
                  <stop offset="1" stop-color="#b3c2de" />
                </linearGradient>
                <linearGradient id="gS1" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#60a5fa" />
                  <stop offset="1" stop-color="#1e3a8a" />
                </linearGradient>
                <linearGradient id="gS2" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#fb7185" />
                  <stop offset="1" stop-color="#be123c" />
                </linearGradient>
                <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="2.8" result="b" />
                  <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <clipPath id="clipVisor"><rect x="58" y="48" width="104" height="76" rx="34" /></clipPath>
              </defs>

              <ellipse class="shadow" cx="110" cy="252" rx="58" ry="7" fill="#000" opacity=".3" />

              <g class="float">
                <!-- Cuerpo -->
                <path d="M56 246C54 196 72 156 110 156s56 40 54 90q-54 10-108 0Z" fill="url(#rgWhite)" />
                <path d="M56 246C54 196 72 156 110 156s56 40 54 90q-54 10-108 0Z" fill="url(#lgShade)" />
                <path d="M74 176q14-14 36-14" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".7" />
                <!-- Hombros -->
                <circle cx="62" cy="188" r="17" fill="url(#rgBlue)" />
                <ellipse cx="57" cy="181" rx="7" ry="4" fill="#fff" opacity=".4" transform="rotate(-30 57 181)" />
                <circle cx="158" cy="188" r="17" fill="url(#rgBlue)" />
                <ellipse cx="153" cy="181" rx="7" ry="4" fill="#fff" opacity=".4" transform="rotate(-30 153 181)" />
                <!-- Placa del pecho -->
                <rect x="82" y="176" width="56" height="58" rx="14" fill="#0b1434" stroke="rgba(130,160,230,.55)" stroke-width="1.5" />
                <g class="chest-glow" transform="translate(94 182) scale(.5)">
                  <path d="M32 3 59 13v22c0 17-12 29-27 34C17 64 5 52 5 35V13Z" fill="url(#gS1)" />
                  <path d="M32 3 59 13v22c0 17-12 29-27 34Z" fill="url(#gS2)" opacity=".6" />
                  <path d="M32 50V24m0 0-9 10m9-10 9 10" fill="none" stroke="#fff" stroke-width="5"
                        stroke-linecap="round" stroke-linejoin="round" />
                </g>
                <text x="110" y="228" text-anchor="middle" font-size="8" font-weight="800" letter-spacing="2"
                      fill="#e2e8f0" font-family="Inter, Segoe UI, sans-serif">RPC</text>

                <!-- Cuello -->
                <rect x="96" y="136" width="28" height="22" rx="7" fill="url(#lgMetal)" />
                <path d="M98 144h24M98 150h24" stroke="#0b1434" stroke-width="1.5" opacity=".6" />

                <!-- Cabeza -->
                <g class="head">
                  <!-- Diadema -->
                  <path d="M38 80A72 52 0 0 1 182 80" fill="none" stroke="#0f2468" stroke-width="12" stroke-linecap="round" />
                  <path d="M38 80A72 52 0 0 1 182 80" fill="none" stroke="url(#rgBlue)" stroke-width="9" stroke-linecap="round" />
                  <path d="M52 56A72 52 0 0 1 100 30" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity=".45" />

                  <rect x="46" y="34" width="128" height="104" rx="48" fill="url(#rgWhite)" />
                  <rect x="46" y="34" width="128" height="104" rx="48" fill="url(#lgShade)" />
                  <ellipse cx="84" cy="46" rx="34" ry="9" fill="#fff" opacity=".6" transform="rotate(-12 84 46)" />

                  <!-- Visor -->
                  <rect x="55" y="45" width="110" height="82" rx="37" fill="#0a1434" opacity=".35" />
                  <rect x="58" y="48" width="104" height="76" rx="34" fill="url(#lgVisor)" stroke="rgba(130,160,230,.5)" stroke-width="1.5" />
                  <g clip-path="url(#clipVisor)">
                    <path d="M70 48 128 48 90 124 58 124Z" fill="#fff" opacity=".07" />
                    <path d="M72 58q38-9 76 0" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".25" />
                  </g>

                  <!-- Orejeras -->
                  <rect x="24" y="64" width="28" height="60" rx="14" fill="url(#rgBlue)" />
                  <rect x="31" y="74" width="14" height="40" rx="7" fill="#0a1a4d" stroke="#5ee1ff" stroke-width="2" filter="url(#glow)" />
                  <rect x="168" y="64" width="28" height="60" rx="14" fill="url(#rgBlue)" />
                  <rect x="175" y="74" width="14" height="40" rx="7" fill="#0a1a4d" stroke="#5ee1ff" stroke-width="2" filter="url(#glow)" />
                  <circle cx="38" cy="124" r="4" fill="url(#rgRed)" />
                  <circle cx="182" cy="124" r="4" fill="url(#rgRed)" />

                  <!-- Ojos -->
                  <g class="eyes">
                    <g class="eye eye-l">
                      <g class="eye-happy" filter="url(#glow)">
                        <path d="M76 92q12-20 24 0" fill="none" stroke="#38d3ff" stroke-width="7" stroke-linecap="round" />
                        <path d="M76 92q12-20 24 0" fill="none" stroke="#eafcff" stroke-width="2" stroke-linecap="round" opacity=".85" />
                      </g>
                      <g class="eye-sad" filter="url(#glow)">
                        <path d="M76 96l24-9" fill="none" stroke="#ff5a78" stroke-width="7" stroke-linecap="round" />
                      </g>
                    </g>
                    <g class="eye eye-r">
                      <g class="eye-happy" filter="url(#glow)">
                        <path d="M120 92q12-20 24 0" fill="none" stroke="#38d3ff" stroke-width="7" stroke-linecap="round" />
                        <path d="M120 92q12-20 24 0" fill="none" stroke="#eafcff" stroke-width="2" stroke-linecap="round" opacity=".85" />
                      </g>
                      <g class="eye-sad" filter="url(#glow)">
                        <path d="M120 87l24 9" fill="none" stroke="#ff5a78" stroke-width="7" stroke-linecap="round" />
                      </g>
                    </g>
                  </g>
                  <!-- Boca -->
                  <g class="mouth-happy" filter="url(#glow)">
                    <path d="M99 104q11 10 22 0" fill="none" stroke="#38d3ff" stroke-width="5.5" stroke-linecap="round" />
                    <path d="M99 104q11 10 22 0" fill="none" stroke="#eafcff" stroke-width="1.6" stroke-linecap="round" opacity=".85" />
                  </g>
                  <g class="mouth-sad" filter="url(#glow)">
                    <path d="M100 110q10-9 20 0" fill="none" stroke="#ff5a78" stroke-width="5.5" stroke-linecap="round" />
                  </g>
                </g>

                <!-- Brazo que saluda -->
                <g class="wave">
                  <line x1="160" y1="188" x2="196" y2="148" stroke="#6d7fa6" stroke-width="19" stroke-linecap="round" />
                  <line x1="160" y1="188" x2="196" y2="148" stroke="#eef3fc" stroke-width="14" stroke-linecap="round" />
                  <line x1="157" y1="184" x2="190" y2="148" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".8" />
                  <rect x="182" y="150" width="26" height="10" rx="5" fill="url(#rgBlue)" transform="rotate(-48 195 155)" />
                  <circle cx="202" cy="134" r="15" fill="url(#rgWhite)" stroke="#b3c3e2" stroke-width="1.5" />
                  <ellipse cx="193" cy="132" rx="5" ry="9" fill="url(#rgWhite)" stroke="#b3c3e2" stroke-width="1.2" transform="rotate(-25 193 132)" />
                </g>

                <!-- Manos que tapan los ojos -->
                <g class="riser riser-l">
                  <rect x="-11" y="8" width="22" height="150" rx="11" fill="url(#lgArm)" stroke="#a5b6d6" stroke-width="1.2" />
                  <rect x="-11" y="26" width="22" height="11" fill="url(#rgBlue)" />
                  <circle cx="0" cy="0" r="20" fill="url(#rgWhite)" stroke="#b3c3e2" stroke-width="1.5" />
                  <ellipse cx="-6" cy="-7" rx="8" ry="4" fill="#fff" opacity=".7" />
                  <path d="M-12 8v8M-4 10v9M4 10v9M12 8v8" stroke="#aebfdc" stroke-width="1.2" stroke-linecap="round" />
                </g>
                <g class="riser riser-r">
                  <rect x="-11" y="8" width="22" height="150" rx="11" fill="url(#lgArm)" stroke="#a5b6d6" stroke-width="1.2" />
                  <rect x="-11" y="26" width="22" height="11" fill="url(#rgBlue)" />
                  <circle cx="0" cy="0" r="20" fill="url(#rgWhite)" stroke="#b3c3e2" stroke-width="1.5" />
                  <ellipse cx="-6" cy="-7" rx="8" ry="4" fill="#fff" opacity=".7" />
                  <path d="M-12 8v8M-4 10v9M4 10v9M12 8v8" stroke="#aebfdc" stroke-width="1.2" stroke-linecap="round" />
                </g>
              </g>
            </svg>
          </div>

          <div class="brand-copy">
            <h2>Todo tu negocio, <span>en una sola plataforma</span></h2>
            <p>Contratos, proformas, obras, servicios y bienes bajo control.</p>
          </div>
        </aside>

        <!-- Formulario -->
        <form class="card" [class.shake]="!!error()" (submit)="$event.preventDefault(); entrar()">
          <div class="card-bar" aria-hidden="true"></div>

          <header class="card-head">
            <h1>Iniciar sesión</h1>
            <p>Ingresa tus credenciales para continuar</p>
          </header>

          <label class="field">
            <span class="label">Usuario o correo</span>
            <span class="control">
              <svg viewBox="0 0 24 24" class="i ico" aria-hidden="true">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21a8 8 0 0 1 16 0" />
              </svg>
              <input type="text" autocomplete="username" placeholder="usuario@correo.com"
                     [value]="usuario()"
                     (input)="usuario.set($any($event.target).value)"
                     (focus)="foco.set('usuario')" (blur)="foco.set('ninguno')" />
            </span>
          </label>

          <label class="field">
            <span class="label">Clave</span>
            <span class="control">
              <svg viewBox="0 0 24 24" class="i ico" aria-hidden="true">
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              <input [type]="verClave() ? 'text' : 'password'" autocomplete="current-password"
                     placeholder="Ingresa tu clave"
                     [value]="clave()"
                     (input)="clave.set($any($event.target).value)"
                     (focus)="foco.set('clave')" (blur)="foco.set('ninguno')" />
              <button type="button" class="eye-btn" (click)="verClave.set(!verClave())"
                      (mousedown)="$event.preventDefault()"
                      [attr.aria-label]="verClave() ? 'Ocultar clave' : 'Mostrar clave'">
                @if (verClave()) {
                  <svg viewBox="0 0 24 24" class="i">
                    <path d="M3 3l18 18" />
                    <path d="M10.6 6.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.4" />
                    <path d="M6.6 6.6A16.5 16.5 0 0 0 2 12s3.5 7 10 7a9.700 9.700 0 0 0 5.400-1.600" />
                    <path d="M9.9 9.9a3 3 0 0 0 4.200 4.200" />
                  </svg>
                } @else {
                  <svg viewBox="0 0 24 24" class="i">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                }
              </button>
            </span>
          </label>

          @if (error()) {
            <p class="login-error" role="alert">
              <svg viewBox="0 0 24 24" class="i" aria-hidden="true">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
              {{ error() }}
            </p>
          }

          <button type="submit" class="btn" [disabled]="cargando() || !usuario() || !clave()">
            @if (cargando()) { <span class="spinner" aria-hidden="true"></span> }
            <span>{{ cargando() ? 'Entrando…' : 'Entrar' }}</span>
            @if (!cargando()) {
              <svg viewBox="0 0 24 24" class="i btn-ico" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            }
          </button>

          <div class="links">
            <a class="login-link" routerLink="/crear-clave">¿Olvidaste tu clave o recibiste un enlace?</a>
            <a class="login-link alt" routerLink="/">← Ver planes y precios</a>
          </div>
        </form>
      </section>
    </main>
  `,
  styles: [`
    :host {
      --navy: #070d24;
      --blue: #2563eb;
      --blue-d: #1d4ed8;
      --sky: #38bdf8;
      --red: #e11d48;
      --red-d: #be123c;
      --ink: #0f172a;
      --muted: #64748b;
      display: block;
      font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif;
    }
    * { box-sizing: border-box; }

    .i { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

    /* ========== Página y fondo ========== */
    .page {
      position: relative;
      min-height: 100vh;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: clamp(14px, 3vw, 40px);
      overflow: hidden;
      background: linear-gradient(155deg, var(--navy) 0%, #14183f 55%, #3a0f2b 100%);
      isolation: isolate;
    }
    .bg { position: absolute; inset: 0; z-index: -1; overflow: hidden; }
    .orb { position: absolute; border-radius: 50%; filter: blur(70px); opacity: .55; will-change: transform; }
    .orb-blue  { width: 46vmax; height: 46vmax; left: -14vmax; top: -16vmax; background: #1d4ed8; animation: drift1 18s ease-in-out infinite alternate; }
    .orb-red   { width: 40vmax; height: 40vmax; right: -12vmax; bottom: -14vmax; background: #e11d48; opacity: .42; animation: drift2 22s ease-in-out infinite alternate; }
    .orb-blue2 { width: 26vmax; height: 26vmax; right: 12%; top: -8vmax; background: #38bdf8; opacity: .25; animation: drift3 16s ease-in-out infinite alternate; }
    .grid {
      position: absolute; inset: 0;
      background-image:
        linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px);
      background-size: 44px 44px;
      mask-image: radial-gradient(ellipse at center, #000 30%, transparent 75%);
      -webkit-mask-image: radial-gradient(ellipse at center, #000 30%, transparent 75%);
    }
    @keyframes drift1 { to { transform: translate(8vmax, 6vmax) scale(1.12); } }
    @keyframes drift2 { to { transform: translate(-7vmax, -5vmax) scale(1.1); } }
    @keyframes drift3 { to { transform: translate(-6vmax, 7vmax) scale(.9); } }

    /* ========== Contenedor ========== */
    .shell {
      width: 100%;
      max-width: 1080px;
      display: grid;
      grid-template-columns: 1fr;
      gap: clamp(18px, 3vw, 40px);
      align-items: center;
      animation: rise .8s cubic-bezier(.2,.8,.2,1) both;
    }
    @keyframes rise { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }

    /* ========== Panel de marca ========== */
    .brand { color: #fff; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; }
    .brand-top { display: flex; align-items: center; gap: 10px; }
    .shield { width: 38px; height: 42px; filter: drop-shadow(0 6px 14px rgba(37,99,235,.55)); animation: pop 1s .2s cubic-bezier(.3,1.6,.5,1) both; }
    @keyframes pop { from { transform: scale(0) rotate(-20deg); opacity: 0; } to { transform: none; opacity: 1; } }
    .brand-name { font-size: 22px; letter-spacing: .18em; font-weight: 500; }
    .brand-name b { font-weight: 800; color: #fb7185; }

    .bubble {
      position: relative;
      max-width: 300px;
      padding: 10px 18px;
      border-radius: 14px;
      background: rgba(255,255,255,.96);
      color: var(--ink);
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 10px 28px rgba(0,0,0,.28);
      animation: bubbleIn .6s .5s cubic-bezier(.3,1.5,.5,1) both;
      margin: 6px 0 2px;
    }
    .bubble::after {
      content: ''; position: absolute; left: 50%; bottom: -7px; width: 14px; height: 14px;
      background: inherit; transform: translateX(-50%) rotate(45deg); border-radius: 3px;
    }
    .bubble-alert { background: #fff1f2; color: var(--red-d); }
    .bubble-text { display: inline-block; animation: textSwap .35s ease both; }
    @keyframes textSwap { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes bubbleIn { from { opacity: 0; transform: translateY(10px) scale(.7); } to { opacity: 1; transform: none; } }

    .brand-copy { display: none; }

    /* ========== Escenario: bot + órbitas ========== */
    .stage {
      --size: min(78vw, 320px);
      --c: 42px;
      position: relative;
      width: var(--size);
      height: var(--size);
      margin: 18px auto 14px;
      display: grid;
      place-items: center;
    }
    .halo {
      position: absolute; width: 70%; height: 70%; border-radius: 50%;
      background: radial-gradient(circle, rgba(56,189,248,.35), rgba(225,29,72,.18) 55%, transparent 72%);
      filter: blur(14px); animation: breathe 5s ease-in-out infinite;
    }
    @keyframes breathe { 50% { transform: scale(1.15); opacity: .75; } }
    .ring { position: absolute; left: 50%; top: 50%; border: 1px dashed rgba(255,255,255,.16); border-radius: 50%; transform: translate(-50%, -50%); }
    .ring1 { width: calc(var(--size) * .64); height: calc(var(--size) * .64); }
    .ring2 { width: calc(var(--size) * .94); height: calc(var(--size) * .94); border-color: rgba(251,113,133,.2); }

    .orbit { position: absolute; inset: 0; animation: spin var(--dur) linear infinite; }
    .o1 { --dur: 36s; --r: calc(var(--size) * .32); }
    .o2 { --dur: 54s; --r: calc(var(--size) * .47); animation-direction: reverse; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .slot {
      position: absolute; left: 50%; top: 50%; width: 0; height: 0;
      transform: rotate(var(--a)) translateX(var(--r)) rotate(calc(var(--a) * -1));
    }
    .chip {
      position: absolute;
      left: calc(var(--c) / -2); top: calc(var(--c) / -2);
      width: var(--c); height: var(--c);
      border-radius: 14px;
      display: grid; place-items: center;
      background: linear-gradient(145deg, rgba(255,255,255,.22), rgba(255,255,255,.06));
      border: 1px solid rgba(255,255,255,.3);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      animation: spin var(--dur) linear infinite reverse;
      cursor: default;
    }
    .o2 .chip { animation-direction: normal; }
    .chip-in { width: 100%; height: 100%; display: grid; place-items: center; animation: bob 3.2s ease-in-out infinite; }
    @keyframes bob { 50% { transform: translateY(-5px); } }
    .chip .i { width: 54%; height: 54%; }
    .tone-b { color: #9cc4ff; box-shadow: 0 8px 22px rgba(37,99,235,.5), inset 0 0 12px rgba(96,165,250,.25); }
    .tone-r { color: #ffb3c0; box-shadow: 0 8px 22px rgba(225,29,72,.45), inset 0 0 12px rgba(251,113,133,.25); }
    .chip::after {
      content: attr(data-l); position: absolute; top: calc(100% + 6px); left: 50%;
      transform: translateX(-50%) translateY(-4px); white-space: nowrap;
      padding: 3px 9px; border-radius: 8px; background: rgba(7,13,36,.92); color: #fff;
      font-size: 11px; font-weight: 600; letter-spacing: .03em;
      opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s;
    }
    .chip:hover::after { opacity: 1; transform: translateX(-50%); }
    .stage:hover .orbit, .stage:hover .chip { animation-play-state: paused; }

    .bot { position: relative; z-index: 2; width: calc(var(--size) * .44); height: auto; overflow: visible; filter: drop-shadow(0 16px 24px rgba(0,0,0,.45)); }

    /* ========== Animaciones del bot ========== */
    .float { animation: floatY 3.6s ease-in-out infinite; }
    @keyframes floatY { 50% { transform: translateY(-7px); } }
    .shadow { animation: shadow 3.6s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
    @keyframes shadow { 50% { transform: scaleX(.82); opacity: .15; } }

    .head { transform-box: view-box; transform-origin: 110px 136px; transition: transform .5s cubic-bezier(.3,1.4,.5,1); }
    .bot.cover .head { transform: rotate(-3deg) translateY(2px); }

    .eye { transform-box: fill-box; transform-origin: center; animation: blink 5s infinite; }
    .eye-r { animation-delay: .04s; }
    @keyframes blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(.1); } }

    .eye-sad, .mouth-sad { opacity: 0; transition: opacity .25s; }
    .eye-happy, .mouth-happy { transition: opacity .25s; }
    .bot.sad .eye-happy, .bot.sad .mouth-happy { opacity: 0; }
    .bot.sad .eye-sad, .bot.sad .mouth-sad { opacity: 1; }
    .bot.sad .head { animation: nope .5s ease 1; }
    @keyframes nope { 25% { transform: rotate(-6deg); } 75% { transform: rotate(6deg); } }
    .bot.busy .eye { animation: scan 1s ease-in-out infinite alternate; }
    @keyframes scan { from { transform: translateX(-4px); } to { transform: translateX(4px); } }

    .chest-glow { animation: pulse 2.8s ease-in-out infinite; }
    @keyframes pulse { 50% { filter: drop-shadow(0 0 5px rgba(56,189,248,.9)); } }

    .wave { transform-box: view-box; transform-origin: 160px 188px; animation: hello 1.2s ease-in-out .9s 3 both; transition: opacity .25s; }
    @keyframes hello { 0%, 100% { transform: rotate(0); } 25% { transform: rotate(-22deg); } 75% { transform: rotate(14deg); } }
    .bot.cover .wave { opacity: 0; animation: none; }

    .riser { opacity: 0; transition: transform .55s cubic-bezier(.3,1.35,.5,1), opacity .25s; }
    .riser-l { transform: translate(88px, 250px); }
    .riser-r { transform: translate(132px, 250px); }
    .bot.cover .riser { opacity: 1; }
    .bot.cover .riser-l { transform: translate(90px, 90px); }
    .bot.cover .riser-r { transform: translate(130px, 90px); }

    /* ========== Tarjeta ========== */
    .card {
      position: relative;
      width: 100%;
      max-width: 440px;
      margin-inline: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: clamp(22px, 4vw, 34px);
      border-radius: 22px;
      background: rgba(255,255,255,.97);
      box-shadow: 0 30px 70px rgba(2,6,23,.55), 0 0 0 1px rgba(255,255,255,.2);
      overflow: hidden;
      animation: rise .9s .15s cubic-bezier(.2,.8,.2,1) both;
    }
    .card-bar {
      position: absolute; inset: 0 0 auto 0; height: 5px;
      background: linear-gradient(90deg, var(--blue-d), var(--sky), var(--red), var(--blue-d));
      background-size: 250% 100%;
      animation: slide 6s linear infinite;
    }
    @keyframes slide { to { background-position: -250% 0; } }
    .card.shake { animation: shake .45s ease; }
    @keyframes shake { 20%,60% { transform: translateX(-8px); } 40%,80% { transform: translateX(8px); } }

    .card-head h1 { margin: 6px 0 4px; font-size: clamp(22px, 5vw, 27px); color: var(--ink); letter-spacing: -.01em; }
    .card-head p { margin: 0; color: var(--muted); font-size: 14px; }

    .field { display: flex; flex-direction: column; gap: 7px; }
    .label { font-size: 13px; font-weight: 700; color: #1e293b; }
    .control {
      position: relative; display: flex; align-items: center;
      border: 1.5px solid #cbd5e1; border-radius: 12px; background: #f8fafc;
      transition: border-color .2s, box-shadow .2s, background .2s, transform .2s;
    }
    .control:focus-within {
      border-color: var(--blue); background: #fff;
      box-shadow: 0 0 0 4px rgba(37,99,235,.15);
      transform: translateY(-1px);
    }
    .ico { width: 19px; height: 19px; margin-left: 13px; color: #94a3b8; flex: none; transition: color .2s; }
    .control:focus-within .ico { color: var(--blue); }
    input {
      flex: 1; min-width: 0; width: 100%;
      padding: 13px 12px; border: 0; outline: 0; background: transparent;
      font-size: 16px; color: var(--ink); font-family: inherit;
    }
    input::placeholder { color: #a8b3c4; }

    .eye-btn {
      flex: none; width: 42px; height: 42px; margin-right: 3px; padding: 0; border: 0; border-radius: 10px;
      background: transparent; cursor: pointer; display: grid; place-items: center; color: #64748b; transition: background .2s, color .2s;
    }
    .eye-btn:hover { background: #e2e8f0; color: var(--blue-d); }
    .eye-btn svg { width: 20px; height: 20px; }

    .login-error {
      display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 12px;
      border-radius: 10px; background: #fff1f2; border: 1px solid #fecdd3;
      color: #be123c; font-size: 13px; font-weight: 600;
      animation: textSwap .3s ease both;
    }
    .login-error svg { width: 18px; height: 18px; flex: none; }

    .btn {
      position: relative; overflow: hidden;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: 14px; border: 0; border-radius: 12px; color: #fff; font-size: 16px; font-weight: 700;
      font-family: inherit; letter-spacing: .02em; cursor: pointer;
      background: linear-gradient(100deg, var(--blue-d) 0%, var(--blue) 45%, var(--red) 100%);
      background-size: 160% 100%; background-position: 0 0;
      box-shadow: 0 12px 24px rgba(37,99,235,.35);
      transition: transform .2s, box-shadow .2s, background-position .5s;
    }
    .btn-ico { width: 20px; height: 20px; transition: transform .25s; }
    .btn:hover:not(:disabled) .btn-ico { transform: translateX(4px); }
    .btn::after {
      content: ''; position: absolute; top: 0; left: -80%; width: 50%; height: 100%;
      background: linear-gradient(100deg, transparent, rgba(255,255,255,.4), transparent);
      transform: skewX(-20deg);
    }
    .btn:hover:not(:disabled) { transform: translateY(-2px); background-position: 100% 0; box-shadow: 0 16px 30px rgba(225,29,72,.35); }
    .btn:hover:not(:disabled)::after { animation: shine .8s ease; }
    .btn:active:not(:disabled) { transform: translateY(0) scale(.98); }
    .btn:focus-visible, .login-link:focus-visible, .eye-btn:focus-visible { outline: 3px solid rgba(56,189,248,.7); outline-offset: 2px; }
    .btn:disabled { opacity: .55; cursor: not-allowed; box-shadow: none; }
    @keyframes shine { to { left: 140%; } }

    .spinner { width: 18px; height: 18px; border-radius: 50%; border: 3px solid rgba(255,255,255,.4); border-top-color: #fff; animation: spin .7s linear infinite; }

    .links { display: flex; flex-direction: column; gap: 10px; margin-top: 2px; }
    .login-link { color: var(--blue-d); font-size: 13.5px; font-weight: 600; text-align: center; text-decoration: none; position: relative; align-self: center; }
    .login-link::after { content: ''; position: absolute; left: 0; right: 0; bottom: -2px; height: 2px; background: currentColor; transform: scaleX(0); transition: transform .25s; transform-origin: left; }
    .login-link:hover::after { transform: scaleX(1); }
    .login-link.alt { color: var(--red-d); }

    /* ========== Responsive ========== */
    @media (min-width: 900px) {
      .shell { grid-template-columns: 1.1fr .9fr; }
      .stage { --size: clamp(320px, 36vw, 440px); --c: 52px; }
      .bubble { font-size: 15px; }
      .brand-copy { display: block; margin-top: 4px; }
      .brand-copy h2 { margin: 0 0 8px; font-size: clamp(22px, 2.3vw, 28px); line-height: 1.2; font-weight: 800; }
      .brand-copy h2 span { background: linear-gradient(90deg, #60a5fa, #fb7185); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .brand-copy p { margin: 0; color: #cbd5e1; font-size: 15px; }
    }
    @media (min-width: 600px) and (max-width: 899px) {
      .stage { --size: 380px; --c: 48px; }
    }
    @media (max-width: 380px) {
      .card { padding: 20px 16px; border-radius: 18px; }
      .stage { --c: 38px; }
    }
    @media (max-height: 640px) and (orientation: landscape) {
      .page { place-items: start center; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
    }
  `],
})
export class LoginComponent {
  private readonly auth: AuthService = inject(AuthService);
  private readonly router: Router = inject(Router);

  readonly usuario = signal<string>('');
  readonly clave = signal<string>('');
  readonly error = signal<string>('');
  readonly cargando = signal<boolean>(false);

  // Estado solo visual (interfaz / bot)
  readonly foco = signal<Foco>('ninguno');
  readonly verClave = signal<boolean>(false);

  /** El bot se tapa los ojos mientras se escribe la clave (si no está visible). */
  readonly tapando = computed<boolean>(() => this.foco() === 'clave' && !this.verClave());

  readonly mensaje = computed<string>(() => {
    if (this.cargando()) return 'Verificando tus datos…';
    if (this.error()) return 'Revisa tus datos e intenta de nuevo';
    if (this.tapando()) return 'No miro, tu clave es privada';
    if (this.foco() === 'clave') return 'Puedes ver tu clave con tranquilidad';
    if (this.foco() === 'usuario') return 'Escribe tu usuario o correo';
    return 'Hola, bienvenido a Grupo RPC';
  });

  // Iconos que orbitan alrededor del bot (trazos estilo línea, 24x24)
  readonly anillo1: IconoOrbita[] = [
    {
      id: 'documentos', etiqueta: 'Documentos', angulo: 0, tono: 'azul', retraso: 0,
      trazos: [
        'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z',
        'M14 3v5h5',
        'M9 13h6M9 17h6M9 9h2',
      ],
    },
    {
      id: 'contratos', etiqueta: 'Contratos', angulo: 90, tono: 'rojo', retraso: .5,
      trazos: [
        'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z',
        'M14 3v5h5',
        'M8 12h5',
        'M8 17c1-3 2-3 2.5-1s1.5 1.500 2.500-.5 1.500-1 2.500 0',
      ],
    },
    {
      id: 'proformas', etiqueta: 'Proformas', angulo: 180, tono: 'azul', retraso: 1,
      trazos: [
        'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
        'M8 7h8',
        'M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01',
      ],
    },
    {
      id: 'fichas', etiqueta: 'Fichas', angulo: 270, tono: 'rojo', retraso: 1.5,
      trazos: [
        'M9 3h6v3H9z',
        'M7 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-1',
        'M9 12h6M9 16h4',
      ],
    },
  ];

  readonly anillo2: IconoOrbita[] = [
    {
      id: 'dinero', etiqueta: 'Dinero', angulo: 45, tono: 'rojo', retraso: .2,
      trazos: [
        'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
        'M9.500 12a2.500 2.500 0 1 0 5 0 2.500 2.500 0 1 0-5 0',
        'M6 12h.01M18 12h.01',
      ],
    },
    {
      id: 'obras', etiqueta: 'Obras', angulo: 135, tono: 'azul', retraso: .7,
      trazos: [
        'M2 18h20',
        'M4 18v-3a8 8 0 0 1 16 0v3',
        'M12 5v6',
        'M8 18v-4M16 18v-4',
      ],
    },
    {
      id: 'servicios', etiqueta: 'Servicios', angulo: 225, tono: 'rojo', retraso: 1.2,
      trazos: [
        'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z',
      ],
    },
    {
      id: 'bienes', etiqueta: 'Bienes', angulo: 315, tono: 'azul', retraso: 1.7,
      trazos: [
        'M21 8v8a2 2 0 0 1-1 1.730l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.730l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z',
        'M3.300 7 12 12l8.700-5',
        'M12 22V12',
      ],
    },
  ];

  entrar(): void {
    if (this.cargando()) return;
    this.cargando.set(true);
    this.error.set('');
    this.auth.login(this.usuario().trim(), this.clave()).subscribe({
      next: () => {
        this.cargando.set(false);
        this.router.navigate(['/']);
      },
      error: (e: HttpErrorResponse) => {
        this.cargando.set(false);
        this.error.set(e.error?.detail ?? 'No se pudo conectar con el servidor');
      },
    });
  }
} 