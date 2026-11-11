<script lang="ts" module>
  export type Choice = "save" | "discard" | "cancel";
</script>

<script lang="ts">
  // Whether to save the unsaved changes of files about to close. Escape is the
  // window's to handle, as Cancel.

  import { t } from "./i18n";

  interface Props {
    names: string[];
    onanswer: (choice: Choice) => void;
  }

  let { names, onanswer }: Props = $props();

  /** A dialog takes the keyboard from the editor behind it. */
  function takeFocus(button: HTMLElement) {
    button.focus();
  }
</script>

<div class="backdrop" role="presentation">
  <div class="dialog" role="alertdialog" aria-labelledby="save-title">
    {#if names.length === 1}
      <p id="save-title">{t("prompt.saveOne", { name: names[0] })}</p>
    {:else}
      <p id="save-title">{t("prompt.saveMany", { count: names.length })}</p>
      <ul>
        {#each names as name, i (i)}
          <li>{name}</li>
        {/each}
      </ul>
    {/if}
    <p class="muted">{t("prompt.lost")}</p>
    <div class="buttons">
      <button class="primary" use:takeFocus onclick={() => onanswer("save")}>{t(names.length === 1 ? "prompt.save" : "prompt.saveAll")}</button>
      <button onclick={() => onanswer("discard")}>{t("prompt.discard")}</button>
      <button onclick={() => onanswer("cancel")}>{t("prompt.cancel")}</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .dialog {
    min-width: 360px;
    padding: 18px 20px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .dialog p {
    margin: 0 0 8px;
  }
  .dialog ul {
    max-height: 200px;
    margin: 0 0 8px;
    padding-left: 20px;
    overflow: auto;
  }
  .muted {
    color: var(--muted);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
