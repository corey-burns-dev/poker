export type BackendHealth = {
  status: string;
  service: string;
  framework: string;
  websocket_path: string;
};

export type BackendPlayer = {
  seat: number;
  name: string;
  stack: number;
  status: string;
  is_bot: boolean;
  will_play_next_hand: boolean;
  show_cards: boolean;
  player_id: string | null;
  connected: boolean;
  bet_this_street: number;
  contributed_this_hand: number;
  hole_cards: Array<string | null>;
};

export type BackendPendingPlayer = {
  player_id: string;
  name: string;
  connected: boolean;
  will_play_next_hand: boolean;
  desired_seat: number;
};

export type BackendHandState = {
  status: string;
  stage: string;
  hand_number: number;
  pot: number;
  current_bet: number;
  minimum_raise: number;
  acting_seat: number | null;
  dealer_seat: number;
  small_blind_seat: number;
  big_blind_seat: number;
  community_cards: string[];
  action_log: string[];
  action_log_seq: number;
  last_action: string;
  acted_seats: number[];
  winner_seats: number[];
  winner_amounts: Record<string, number>;
  hand_result: {
    heading: string;
    lines: string[];
    hero_outcome: "win" | "loss" | "split" | "folded" | "info";
  } | null;
};

export type BackendTable = {
  table_id: string;
  players: BackendPlayer[];
  pending_players: BackendPendingPlayer[];
  game_state: string;
  hand_number: number;
  connected_clients: number;
  last_event: string;
  hand_state: BackendHandState;
};
