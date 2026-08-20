import { useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from 'react';
import '../styles/liaLogin.css';

type LiaLoginScreenProps = {
  email: string;
  password: string;
  error: string | null;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onCreateAccount: () => void;
  pending?: boolean;
};

export function LiaLoginScreen({
  email,
  password,
  error,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onCreateAccount,
  pending = false,
}: LiaLoginScreenProps) {
  const [showPassword, setShowPassword] = useState(false);
  const screenRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const node = screenRef.current;
    if (!node || typeof window === 'undefined') return;

    /*
     * Cross-browser viewport stabilizer.
     * Mantiene el efecto de repintado que demostró V14,
     * pero sin diagnóstico visible.
     */
    const sentinel = document.createElement('span');
    sentinel.setAttribute('aria-hidden', 'true');
    Object.assign(sentinel.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '1px',
      height: '1px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      background: 'rgb(2, 9, 17)',
    });
    document.body.appendChild(sentinel);

    let frame = 0;
    let settleFrame = 0;
    let paintTick = 0;

    const syncViewport = () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);

      frame = window.requestAnimationFrame(() => {
        const viewport = window.visualViewport;
        const width = Math.round(viewport?.width ?? document.documentElement.clientWidth ?? window.innerWidth);
        const height = Math.round(viewport?.height ?? document.documentElement.clientHeight ?? window.innerHeight);

        node.style.setProperty('--lia-login-vw', `${width}px`);
        node.style.setProperty('--lia-login-vh', `${height}px`);

        /* Lectura de geometría: estabiliza layout después del resize. */
        node.getBoundingClientRect();
        node.querySelector('.lia-login-r1-stack')?.getBoundingClientRect();
        node.querySelector('.lia-login-r1-panel')?.getBoundingClientRect();

        /*
         * Un píxel del mismo fondo cambia un nivel imperceptible.
         * Fuerza repaint real sin overlay ni parpadeo.
         */
        paintTick += 1;
        sentinel.style.background =
          paintTick % 2
            ? 'rgb(2, 9, 17)'
            : 'rgb(2, 9, 18)';

        settleFrame = window.requestAnimationFrame(() => {
          node.getBoundingClientRect();
        });
      });
    };

    syncViewport();

    window.addEventListener('resize', syncViewport, { passive: true });
    window.addEventListener('orientationchange', syncViewport, { passive: true });
    window.visualViewport?.addEventListener('resize', syncViewport, { passive: true });

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(syncViewport)
        : null;

    observer?.observe(document.documentElement);

    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
      window.visualViewport?.removeEventListener('resize', syncViewport);
      observer?.disconnect();
      sentinel.remove();
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse') return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
    const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;

    event.currentTarget.style.setProperty('--lia-motion-x', `${x * 7}px`);
    event.currentTarget.style.setProperty('--lia-motion-y', `${y * 6}px`);
  };

  const resetPointerMotion = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.style.setProperty('--lia-motion-x', '0px');
    event.currentTarget.style.setProperty('--lia-motion-y', '0px');
  };

  const nodes = [
    { x: '8%', y: '24%', size: '3px', duration: '4.8s', delay: '-1.2s' },
    { x: '17%', y: '39%', size: '4px', duration: '5.6s', delay: '-3.4s' },
    { x: '25%', y: '67%', size: '2px', duration: '4.2s', delay: '-0.8s' },
    { x: '34%', y: '18%', size: '3px', duration: '6.1s', delay: '-4.1s' },
    { x: '68%', y: '21%', size: '2px', duration: '4.7s', delay: '-2.7s' },
    { x: '76%', y: '36%', size: '4px', duration: '5.9s', delay: '-1.6s' },
    { x: '87%', y: '57%', size: '3px', duration: '5.2s', delay: '-3.8s' },
    { x: '93%', y: '29%', size: '2px', duration: '4.4s', delay: '-2.1s' },
  ];

  return (
    <main
      ref={screenRef}
      className="lia-login-r1-screen"
      onPointerMove={handlePointerMove}
      onPointerLeave={resetPointerMotion}
    >
      <div className="lia-login-r1-motion" aria-hidden="true">
        <div className="lia-login-r1-map-layer" />
        <div className="lia-login-r1-aurora-layer" />
        <div className="lia-login-r1-sheen-layer" />
        <div className="lia-login-r1-node-layer">
          {nodes.map((node, index) => (
            <span
              key={index}
              style={{
                '--node-x': node.x,
                '--node-y': node.y,
                '--node-size': node.size,
                '--node-duration': node.duration,
                '--node-delay': node.delay,
              } as CSSProperties}
            />
          ))}
        </div>
      </div>
      <div className="lia-login-r1-stack">
        <section className="lia-login-r1-panel" aria-labelledby="lia-login-r1-title">
        <div className="lia-login-r1-seal" aria-hidden="true">LÍA</div>
        <h1 id="lia-login-r1-title" className="lia-login-r1-title">LÍA O.S.</h1>
        <p className="lia-login-r1-subtitle">Centro de Comando</p>

        <form className="lia-login-r1-form" onSubmit={handleSubmit} noValidate>
          <label className="lia-login-r1-visually-hidden" htmlFor="lia-login-r1-email">
            Correo electrónico
          </label>
          <div className="lia-login-r1-field">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m4 7 8 6 8-6" />
            </svg>
            <input
              id="lia-login-r1-email"
              type="email"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              placeholder="Correo electrónico"
              autoComplete="username"
            />
          </div>

          <label className="lia-login-r1-visually-hidden" htmlFor="lia-login-r1-password">
            Contraseña
          </label>
          <div className="lia-login-r1-field">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <rect x="4" y="10" width="16" height="11" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            <input
              id="lia-login-r1-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder="Contraseña"
              autoComplete="current-password"
            />
            <button
              className="lia-login-r1-password-toggle"
              type="button"
              aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? (
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M3 3 21 21" />
                  <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
                  <path d="M9.9 4.2A10.7 10.7 0 0 1 12 4c5.5 0 9 6 9 6a15.7 15.7 0 0 1-2.1 2.8M6.6 6.6C4.3 8.2 3 10 3 10s3.5 6 9 6c1.2 0 2.3-.3 3.3-.7" />
                </svg>
              ) : (
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" />
                  <circle cx="12" cy="12" r="2.5" />
                </svg>
              )}
            </button>
          </div>

          <div className="lia-login-r1-error" aria-live="polite">
            {error ?? ''}
          </div>

          <button className="lia-login-r1-submit" type="submit" disabled={pending}>
              {pending ? 'Entrando…' : 'Iniciar sesión'}
            </button>

            <button
              className="lia-login-r1-create-account"
              type="button"
              disabled={pending}
              onClick={onCreateAccount}
            >
              Crear una cuenta nueva
            </button>

          <div className="lia-login-r1-divider"><span>o continúa con</span></div>

          <button className="lia-login-r1-biometric" type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M7.8 9.4A4.5 4.5 0 0 1 12 6.5a4.5 4.5 0 0 1 4.5 4.5c0 4.4-1.5 7.2-3 9" />
              <path d="M5.2 8.2A7.4 7.4 0 0 1 12 4a7 7 0 0 1 7 7c0 4.2-1 7.3-2.3 9.5" />
              <path d="M4 12.2c.1 3.8-.7 5.8-1.5 7.3M8.5 12c0 3.9-.5 6.3-1.7 8.4M12 10a1.5 1.5 0 0 1 1.5 1.5c0 3.8-.8 7.2-2 9.5" />
            </svg>
            Acceso biométrico
          </button>

          <button className="lia-login-r1-forgot" type="button">
            ¿Olvidaste tu contraseña?
          </button>
        </form>
        </section>

        <div className="lia-login-r1-status" role="status">
          <span className="lia-login-r1-status-dot" aria-hidden="true" />
          <span>Sistema operativo</span>
          <strong>En línea</strong>
        </div>
      </div>
    </main>
  );
}
