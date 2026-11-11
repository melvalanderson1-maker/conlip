/**
 * Pago con tarjeta: Culqi Custom Checkout + 3D Secure (Culqi3DS).
 * La tarjeta se ingresa en el formulario de Culqi: sus datos nunca pasan por nuestro servidor.
 */
interface CulqiToken { id: string; email?: string; }
interface CulqiInstancia {
  open(): void;
  close(): void;
  token?: CulqiToken;
  order?: unknown;
  error?: { user_message?: string; merchant_message?: string };
  culqi?: () => void;
}
interface Culqi3DSApi {
  publicKey: string;
  settings: { charge: { totalAmount: number; returnUrl: string; currency?: string }; card: { email: string } };
  options: Record<string, unknown>;
  generateDevice(): Promise<string | null>;
  initAuthentication(tokenId?: string): Promise<void>;
  reset(): void;
}
interface VentanaCulqi {
  CulqiCheckout?: new (llave: string, config: Record<string, unknown>) => CulqiInstancia;
  Culqi3DS?: Culqi3DSApi;
}

const ventana = (): VentanaCulqi => window as unknown as VentanaCulqi;
const cargas = new Map<string, Promise<void>>();

function cargarScript(url: string, listo: () => boolean): Promise<void> {
  if (listo()) return Promise.resolve();
  let p = cargas.get(url);
  if (!p) {
    p = new Promise<void>((ok, fallo) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => ok();
      s.onerror = () => { cargas.delete(url); fallo(new Error('No se pudo cargar el formulario de pago. Revisa tu conexión.')); };
      document.head.appendChild(s);
    });
    cargas.set(url, p);
  }
  return p;
}

export interface DatosCobro { total: number; moneda: string; llave: string; correo?: string; }

/** Abre el formulario seguro de Culqi y devuelve el token de la tarjeta. */
function obtenerToken(o: DatosCobro): Promise<CulqiToken> {
  const Checkout = ventana().CulqiCheckout;
  if (!Checkout) return Promise.reject(new Error('El formulario de pago no está disponible'));
  return new Promise<CulqiToken>((ok, fallo) => {
    const config: Record<string, unknown> = {
      settings: { title: 'COTI', currency: o.moneda, amount: Math.round(o.total * 100) },
      ...(o.correo ? { client: { email: o.correo } } : {}),
      options: {
        lang: 'auto', installments: false, modal: true,
        paymentMethods: { tarjeta: true, yape: false, billetera: false, bancaMovil: false, agente: false, cuotealo: false },
      },
      appearance: {},
    };
    const culqi = new Checkout(o.llave, config);
    culqi.culqi = () => {
      if (culqi.token) { culqi.close(); ok(culqi.token); }
      else if (culqi.error) { fallo(new Error(culqi.error.user_message ?? 'No se pudo procesar la tarjeta')); }
    };
    culqi.open();
  });
}

/** Abre la ventana de verificación del banco y devuelve los parámetros que Culqi pide para repetir el cargo. */
function autenticar3DS(llave: string, token: CulqiToken, total: number): Promise<Record<string, string>> {
  const T = ventana().Culqi3DS;
  if (!T) return Promise.reject(new Error('No se pudo cargar la verificación de tu banco. Desactiva el bloqueador de anuncios e intenta de nuevo.'));
  T.publicKey = llave;
  T.settings = { charge: { totalAmount: Math.round(total * 100), returnUrl: location.href }, card: { email: token.email ?? '' } };
  T.options = { showModal: true, showLoading: true, showIcon: true, style: { btnColor: '#1d4ed8', btnTextColor: '#FFFFFF' } };
  return new Promise<Record<string, string>>((ok, fallo) => {
    let reloj = 0;
    const terminar = (): void => { window.clearTimeout(reloj); window.removeEventListener('message', escuchar); T.reset(); };
    const escuchar = (ev: MessageEvent): void => {
      if (ev.origin !== window.location.origin) return;
      const r = ev.data as { parameters3DS?: Record<string, string>; error?: string } | null;
      if (!r || typeof r !== 'object') return;
      if (r.parameters3DS) { terminar(); ok(r.parameters3DS); }
      else if (r.error) { terminar(); fallo(new Error(r.error)); }
    };
    window.addEventListener('message', escuchar, false);
    reloj = window.setTimeout(() => { terminar(); fallo(new Error('La verificación de tu banco tardó demasiado. Intenta de nuevo.')); }, 5 * 60_000);
    T.initAuthentication(token.id).catch(() => { terminar(); fallo(new Error('No se pudo iniciar la verificación de tu banco. Intenta de nuevo.')); });
  });
}

/**
 * Cobra con tarjeta de principio a fin: formulario, cobro y, si el banco lo pide, 3D Secure.
 * `enviar` manda los datos al servidor (POST .../pagar) y devuelve su respuesta; `ocupado` enciende/apaga el "Procesando…".
 */
export async function pagarConCulqi<T extends object>(
  o: DatosCobro,
  enviar: (datos: Record<string, unknown>) => Promise<T>,
  ocupado: (v: boolean) => void,
): Promise<T> {
  if (!o.llave) throw new Error('El pago con tarjeta no está configurado');
  await cargarScript('https://js.culqi.com/checkout-js', () => !!ventana().CulqiCheckout);
  await cargarScript('https://3ds.culqi.com', () => !!ventana().Culqi3DS).catch(() => undefined); // sin esta librería solo fallan las tarjetas que piden 3DS

  const token = await obtenerToken(o);
  ocupado(true);
  try {
    let device_id: string | undefined;
    const T = ventana().Culqi3DS;
    if (T) {
      T.publicKey = o.llave;
      try { device_id = (await T.generateDevice()) ?? undefined; } catch { /* se sigue sin identificador del dispositivo */ }
    }
    const base = { token: token.id, device_id };
    let r = await enviar(base);
    if ((r as { requiere_3ds?: boolean }).requiere_3ds) {
      const auth3ds = await autenticar3DS(o.llave, token, o.total);
      r = await enviar({ ...base, auth3ds });
    }
    return r;
  } finally {
    ocupado(false);
  }
}