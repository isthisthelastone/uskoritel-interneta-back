export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      blogers_promo: {
        Row: {
          amount_of_discount: number
          bloger_name: string
          created_at: string
          internal_uuid: string
          promocode: string
          state_for_reffered_by: Json | null
          updated_at: string
        }
        Insert: {
          amount_of_discount?: number
          bloger_name: string
          created_at?: string
          internal_uuid?: string
          promocode: string
          state_for_reffered_by?: Json | null
          updated_at?: string
        }
        Update: {
          amount_of_discount?: number
          bloger_name?: string
          created_at?: string
          internal_uuid?: string
          promocode?: string
          state_for_reffered_by?: Json | null
          updated_at?: string
        }
        Relationships: []
      }
      subscription_prices: {
        Row: {
          created_at: string
          internal_uuid: string
          months: number
          rubles: number
          stars: number
          updated_at: string
          usdt: number
        }
        Insert: {
          created_at?: string
          internal_uuid?: string
          months: number
          rubles: number
          stars: number
          updated_at?: string
          usdt: number
        }
        Update: {
          created_at?: string
          internal_uuid?: string
          months?: number
          rubles?: number
          stars?: number
          updated_at?: string
          usdt?: number
        }
        Relationships: []
      }
      users: {
        Row: {
          created_at: string
          current_discount: number
          earned_money: number
          gifts: Json
          has_purchased: boolean
          internal_uuid: string
          number_of_connections: number
          number_of_connections_last_month: number
          number_of_referals: number
          promo: string | null
          refferals_data: Json
          reffered_by: Json | null
          subscription_active: boolean
          subscription_status: string | null
          subscription_untill: string | null
          tg_id: string
          tg_nickname: string | null
          traffic_consumed_mb: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_discount?: number
          earned_money?: number
          gifts?: Json
          has_purchased?: boolean
          internal_uuid?: string
          number_of_connections?: number
          number_of_connections_last_month?: number
          number_of_referals?: number
          promo?: string | null
          refferals_data?: Json
          reffered_by?: Json | null
          subscription_active?: boolean
          subscription_status?: string | null
          subscription_untill?: string | null
          tg_id: string
          tg_nickname?: string | null
          traffic_consumed_mb?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_discount?: number
          earned_money?: number
          gifts?: Json
          has_purchased?: boolean
          internal_uuid?: string
          number_of_connections?: number
          number_of_connections_last_month?: number
          number_of_referals?: number
          promo?: string | null
          refferals_data?: Json
          reffered_by?: Json | null
          subscription_active?: boolean
          subscription_status?: string | null
          subscription_untill?: string | null
          tg_id?: string
          tg_nickname?: string | null
          traffic_consumed_mb?: number
          updated_at?: string
        }
        Relationships: []
      }
      vps: {
        Row: {
          api_address: string
          config_list: string[]
          country: string
          country_emoji: string
          created_at: string
          domain: string
          internal_uuid: string
          nickname: string | null
          number_of_connections: number
          optional_passsword: string | null
          password: string
          ssh_key: string
          updated_at: string
          users_kv_map: Json
        }
        Insert: {
          api_address: string
          config_list?: string[]
          country: string
          country_emoji: string
          created_at?: string
          domain: string
          internal_uuid?: string
          nickname?: string | null
          number_of_connections?: number
          optional_passsword?: string | null
          password: string
          ssh_key: string
          updated_at?: string
          users_kv_map?: Json
        }
        Update: {
          api_address?: string
          config_list?: string[]
          country?: string
          country_emoji?: string
          created_at?: string
          domain?: string
          internal_uuid?: string
          nickname?: string | null
          number_of_connections?: number
          optional_passsword?: string | null
          password?: string
          ssh_key?: string
          updated_at?: string
          users_kv_map?: Json
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
