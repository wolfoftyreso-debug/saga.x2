-- Vercel AI Gateway exposes Grok under spacexai/. SAGA's logical provider
-- remains xai. Retain old model IDs so existing profiles need no data rewrite;
-- the Gateway boundary canonicalizes that legacy namespace when it is used.
begin;

-- PostgreSQL's regex repetition bound is 255, so the original {0,260}
-- accepted at DDL time fails when any model profile is written. These two
-- adjacent ranges retain the exact same 0..260-character suffix allowance.
alter table content_engine_model_presets
  drop constraint content_engine_model_presets_model_id_check;

alter table content_engine_model_presets
  add constraint content_engine_model_presets_model_id_check check (
    model_id ~ '^[a-z0-9][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}[A-Za-z0-9._:-]{0,5}$'
  );

alter table content_engine_model_presets
  drop constraint content_engine_model_presets_check;

alter table content_engine_model_presets
  add constraint content_engine_model_presets_check check (
    (provider = 'openai' and model_id like 'openai/%')
    or (provider = 'anthropic' and model_id like 'anthropic/%')
    or (provider = 'google' and model_id like 'google/%')
    or (provider = 'xai' and (model_id like 'spacexai/%' or model_id like 'xai/%'))
    or (provider = 'other' and model_id ~ '^(mistral|cohere|perplexity|deepseek|meta|amazon-bedrock)/')
  );

commit;
