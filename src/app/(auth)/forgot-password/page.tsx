"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { KeyRound, ArrowLeft } from "lucide-react";

// Password reset by email is disabled in this deployment (no transactional
// email provider is configured yet). Until email is wired up, an account
// owner/admin resets a member's password from Settings → Team. This page
// explains that instead of collecting an email that would go nowhere.
export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">
            Reset your password
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Password reset by email isn&apos;t available yet on this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground leading-relaxed">
            To regain access, ask your account owner or an administrator to set a
            new password for you from{" "}
            <span className="text-foreground">Settings → Team</span>. If you are
            the account owner, contact your system administrator.
          </div>

          <Link
            href="/login"
            className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
