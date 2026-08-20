import type { LiaCoreModel } from './liaCoreState';

type LiaCoreR3Props = {
  model: LiaCoreModel;
  variant?: 'hero' | 'compact';
};

export function LiaCoreR3({ model, variant = 'hero' }: LiaCoreR3Props) {
  return (
    <section className={`lia-core-r3 is-${model.state} is-${variant}`} data-lia-core-state={model.state} aria-label={model.ariaLabel} role="status">
      <div className="lia-core-r3-stage" aria-hidden="true">
        <i className="lia-core-r3-halo lia-core-r3-halo-outer" />
        <i className="lia-core-r3-halo lia-core-r3-halo-inner" />
        <i className="lia-core-r3-orbit lia-core-r3-orbit-a" />
        <i className="lia-core-r3-orbit lia-core-r3-orbit-b" />
        <i className="lia-core-r3-orbit lia-core-r3-orbit-c" />
        <i className="lia-core-r3-signal" />
        <i className="lia-core-r3-ambient-line is-a" />
        <i className="lia-core-r3-ambient-line is-b" />
        <i className="lia-core-r3-particle is-a" />
        <i className="lia-core-r3-particle is-b" />
        <i className="lia-core-r3-particle is-c" />
        <i className="lia-core-r3-particle is-d" />
        <div className="lia-core-r3-orb">
          <i className="lia-core-r3-shell" />
          <i className="lia-core-r3-membrane" />
          <i className="lia-core-r3-inner-glow" />
          <i className="lia-core-r3-nucleus" />
          <i className="lia-core-r3-rim" />
          <i className="lia-core-r3-specular" />
        </div>
        <i className="lia-core-r3-base-shadow" />
      </div>
      <div className="lia-core-r3-copy">
        <strong>LÍA</strong>
        <span>{model.label}</span>
        {variant === 'hero' && model.context && <small title={model.context}>{model.context}</small>}
      </div>
    </section>
  );
}
