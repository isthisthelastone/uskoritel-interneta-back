import { z } from "zod";

export const xrayTrojanClientSchema = z.object({
  password: z.string().min(1),
  email: z.string().min(1).max(255).optional(),
});

export const xrayTrojanInboundSchema = z.object({
  tag: z.string().min(1),
  listen: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  protocol: z.literal("trojan"),
  settings: z.object({
    clients: z.array(xrayTrojanClientSchema),
  }),
  streamSettings: z.object({
    network: z.literal("tcp"),
    security: z.literal("tls"),
    tlsSettings: z.object({
      alpn: z.array(z.string().min(1)).min(1),
      minVersion: z.string().optional(),
      certificates: z
        .array(
          z.object({
            certificateFile: z.string().min(1),
            keyFile: z.string().min(1),
          }),
        )
        .min(1),
    }),
  }),
});

export const xrayConfigSchema = z.object({
  log: z.object({
    loglevel: z.string().min(1),
  }),
  inbounds: z.array(xrayTrojanInboundSchema),
  outbounds: z.array(
    z.object({
      protocol: z.string().min(1),
    }),
  ),
});

export type XrayTrojanClient = z.infer<typeof xrayTrojanClientSchema>;
export type XrayTrojanInbound = z.infer<typeof xrayTrojanInboundSchema>;
export type XrayConfig = z.infer<typeof xrayConfigSchema>;

export interface VpsUserCredentialEntry {
  passwordBase64: string;
  directUrl: string;
  obfsUrl: string;
  createdAt: string;
  active: boolean;
}

export type VpsUsersKvMap = Record<string, VpsUserCredentialEntry>;

export interface IssueUserTrojanCredentialsRequest {
  internalUuid: string;
  userInternalUuid: string;
}

export interface IssueUserTrojanCredentialsResult {
  internalUuid: string;
  userInternalUuid: string;
  created: boolean;
  directUrl: string;
  obfsUrl: string;
}

export interface RevokeExpiredTrojanCredentialsRequest {
  nowDate: string;
}
