// Todas las magnitudes en metros, segundos y radianes.
// Este archivo no depende de three.js: lo usan el juego y los tests de Node.

// --- Tiempo ---
export const FIXED_DT = 1 / 120;      // paso de simulación
export const MAX_FRAME_DT = 0.1;      // un fotograma nunca aporta más de 100 ms
export const MAX_SUBSTEPS = 12;       // tope de pasos por fotograma (MAX_FRAME_DT / FIXED_DT)

// --- Pista ---
export const SAMPLE_STEP = 1;         // distancia entre muestras de la línea central
export const TRACK_HALF_WIDTH = 5;    // calzada de 10 m
export const MIN_TRACK_WIDTH = 8;
export const SLAB_THICKNESS = 1.4;    // espesor visible del tablero
export const MAX_GRADE = 0.10;        // pendiente máxima (10 %)
export const MAX_HEADING = 1.15;      // rumbo máximo respecto del eje inicial: impide que la ruta se cruce
export const MIN_RADIUS = 32;         // radio mínimo absoluto de curva
export const HEIGHT_LIMIT = 18;       // la cota de la ruta se mantiene en ±HEIGHT_LIMIT
export const START_STRAIGHT = 140;    // recta inicial, sin obstáculos
export const START_S = 24;            // dónde se apoya el auto dentro de la recta inicial
export const SAFE_ZONE = 200;         // sin saltos ni obstáculos antes de este punto
export const FOG_NEAR = 120;
export const FOG_FAR = 300;
export const MIN_AHEAD = FOG_FAR + 90;  // pista mínima por delante, siempre más allá de la niebla
export const AHEAD_SECONDS = 6;         // y además 6 s de recorrido a la velocidad máxima posible (nitro)
export const KEEP_BEHIND = 90;          // pista que se conserva detrás del auto
export const LANE_WIDTH = (TRACK_HALF_WIDTH * 2) / 3;
export const LANES = [-LANE_WIDTH, 0, LANE_WIDTH];  // centros de carril izquierdo, central y derecho

// --- Vehículo ---
export const CAR_WIDTH = 1.8;
export const CAR_LENGTH = 3.8;
export const WHEELBASE = 2.4;
export const WHEEL_TRACK = 1.62;
export const WHEEL_RADIUS = 0.36;
export const SPEED_START = 22;
export const SPEED_MAX = 40;
export const SPEED_GAIN = 0.0045;      // m/s ganados por metro recorrido
export const ACCEL = 18;               // m/s² para alcanzar la velocidad objetivo
export const DECEL = 22;               // m/s² al volver a la velocidad base (fin del nitro)
// Dirección: el auto tiene rumbo propio. La pista NO lo orienta: para seguir una curva
// el jugador tiene que girar. El giro máximo lo limita el agarre lateral (GRIP = v · ω).
export const GRIP = 30;                // aceleración lateral máxima (m/s²)
export const YAW_CAP = 1.5;            // velocidad de giro máxima (rad/s) a baja velocidad
export const STEER_IN = 4.5;           // el volante llega a tope en ~0,22 s al mantener pulsado
export const STEER_OUT = 9;            // y vuelve al centro en ~0,11 s al soltar (no corrige el rumbo)
export const CURVE_BUDGET = 0.6;       // una curva a velocidad base usa ≤ 60 % del agarre
export const AIR_CONTROL = 0.45;       // fracción de dirección disponible en el aire
export const GRAVITY = 30;
export const JUMP_SPEED = 11;          // salto con botón: altura máxima ≈ 2,0 m (no supera los pinchos)
export const LAND_TOLERANCE = 0.25;    // cuánto puede quedar el auto por debajo del plano y aun así apoyarse
export const FALL_DEPTH = 18;          // derrota cuando cae esto por debajo del último apoyo
export const FALL_TIME = 2.2;
export const CRASH_TIME = 0.9;
export const COUNTDOWN = 1.8;

// --- Nitro ---
export const NITRO_MULT = 3;           // velocidad objetivo ×3 (booleano: nunca se acumula)
export const NITRO_ACCEL = 55;         // m/s² mientras el nitro empuja
export const NITRO_DURATION = 4;       // segundos de nitro con la barra llena
export const NITRO_RECHARGE = 14;      // segundos para recargar la barra vacía
export const NITRO_MIN_START = 0.25;   // energía mínima para encenderlo
export const NITRO_COIN = 0.06;        // energía que aporta cada moneda

// --- Rampa de un carril + barrera de pinchos ---
export const LANE_RAMP_WIDTH = 3.0;
export const LANE_RAMP_LENGTH = 16;
export const LANE_RAMP_RISE = 2.0;
export const LANE_RAMP_VY_MIN = 8;     // impulso vertical al despegar, acotado: el salto supera
export const LANE_RAMP_VY_MAX = 10;    // los pinchos a cualquier velocidad sin vuelos desmedidos
export const RAMP_MOUNT_LIFT = 0.35;   // sólo se sube a la rampa por su comienzo
export const SPIKE_HEIGHT = 2.3;       // más alto que el salto con botón
export const SPIKE_DEPTH = 1.2;
export const SPIKE_OFFSET = 8;         // del final de la rampa al frente de la barrera

export function baseSpeedAt(s: number): number {
  return Math.min(SPEED_MAX, SPEED_START + Math.max(0, s) * SPEED_GAIN);
}

// Radio mínimo para que, a velocidad base, la curva use como mucho CURVE_BUDGET del agarre.
export function requiredRadius(v: number): number {
  return Math.max(MIN_RADIUS, (v * v) / (GRIP * CURVE_BUDGET));
}

// Velocidad de giro máxima: limitada por el agarre y nula con el auto detenido.
export function yawMax(v: number): number {
  return Math.min(YAW_CAP * Math.min(1, v / 8), GRIP / Math.max(v, 1));
}

// Metros de avance que necesita un desplazamiento lateral (giro + contragiro al máximo),
// incluido el tiempo de llevar el volante a tope. En curva queda menos agarre libre.
export function laneChangeDistance(v: number, lateral: number, kappa = 0): number {
  const grip = Math.max(GRIP * 0.25, GRIP - v * v * Math.abs(kappa));
  return v * Math.sqrt((4 * Math.abs(lateral)) / grip) + v / STEER_IN;
}

export function requiredAhead(s: number): number {
  return Math.max(MIN_AHEAD, baseSpeedAt(s + 400) * NITRO_MULT * AHEAD_SECONDS);
}

// --- Helicóptero que arroja pinchos ---
// Aparece a los HELI_START metros, baja del cielo y vuela por encima de la ruta (en
// coordenadas de pista: sigue cada curva). Antes de soltar se ubica sobre un carril y avisa.
export const HELI_START = 500;         // metros recorridos (helicóptero de pinchos)
export const HELI_ALT = 8;             // altura de crucero sobre la calzada
export const HELI_ENTER_ALT = 75;      // desde dónde baja
export const HELI_ENTER_TIME = 3.2;
export const HELI_LEAD_TIME = 2.6;     // va adelante del vehículo: ~2,6 s de recorrido…
export const HELI_LEAD_MIN = 75;       // …nunca menos de 75 m
export const HELI_LEAD_MAX = 200;
export const HELI_COOLDOWN_MIN = 2.5;
export const HELI_COOLDOWN_MAX = 5;
export const CALTROP_GRAVITY = 30;
export const CALTROP_WIDTH = LANE_WIDTH - 0.3;  // ocupa un solo carril
export const CALTROP_DEPTH = 1.4;
export const CALTROP_HEIGHT = 0.45;    // se pueden saltar con el botón
export const ATTACK_GAP = 2.0;         // segundos entre el fin de un ataque y el comienzo de otro

// --- Helicóptero con misiles ---
// Marca en el suelo la zona exacta del impacto, recién después dispara; el misil avanza
// según lo que avanza el vehículo y explota justo cuando éste llega a la zona.
export const MISSILE_START = 1000;
export const MISSILE_ALT = 15;          // más alto que el de los pinchos: nunca se cruzan
export const MISSILE_LEAD_TIME = 4.0;   // más adelante que el de los pinchos: no se superponen
export const MISSILE_LEAD_MIN = 125;
export const MISSILE_MARK_TIME = 1.0;   // la zona roja se ve al menos esto antes del disparo
export const MISSILE_MIN_FLIGHT = 0.8;  // segundos de vuelo mínimos (para que se vea venir)
export const MISSILE_ZONE_DEPTH = 4;
export const MISSILE_ZONE_WIDTH = LANE_WIDTH - 0.3;  // un solo carril
export const MISSILE_HEIGHT = 3;        // la explosión no se salta
export const MISSILE_COOLDOWN_MIN = 3;
export const MISSILE_COOLDOWN_MAX = 6;

// --- Vidas ---
export const LIVES = 3;
export const RESPAWN_CRASH_TIME = 1.5;    // giro en el aire hasta el lugar seguro
export const RESPAWN_DROP_TIME = 0.7;     // se lo ve caer un instante…
export const RESPAWN_FLY_TIME = 2.0;      // …y vuelve en una burbuja
export const RESPAWN_HOP = 4.5;           // altura del giro en el aire
export const INVULNERABLE_TIME = 2.2;     // protección después de reaparecer
export const RESPAWN_CLEAR_TIME = 1.6;    // segundos de carril libre por delante al reaparecer

// --- Freno ---
export const BRAKE_MIN_SPEED = 30 / 3.6;  // nunca menos de 30 km/h
export const BRAKE_DECEL = 38;            // m/s²: frenada fuerte y bien notoria
export const BRAKE_CLEAR = 80;            // sin efecto a menos de esto de un salto o rampa
export const CALTROP_REACTION = 0.6;   // segundos de reacción humana que se descuentan al validar
