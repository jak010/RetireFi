import json
from functools import cached_property

from slack_sdk.web import WebClient


class SlackClient:
    FINANCE_CHNNAEL = "C0B61NFQ8CE"
    INFORMATION_CHANNEL = "C0B6Y82LJ48"
    REPORT = "C0B9UJ6RZNG"

    def __init__(self, token):
        self.token = token

    @cached_property
    def get_client(self):
        return WebClient(token=self.token)

    def send_message(self, text):
        self.get_client.chat_postMessage(channel=self.INFORMATION_CHANNEL, text=text)

    def send_block_message(self, blockkit_json: str):
        blocks = json.loads(blockkit_json)

        self.get_client.chat_postMessage(
            channel=self.INFORMATION_CHANNEL,
            text="Investment Report",  # fallback text
            blocks=blocks["blocks"]
        )

    def sned_message_with_file(self,
                               title: str,
                               comment: str,
                               file_path: str,
                               channel:str = None
                               ):
        return self.get_client.files_upload_v2(
            channel=channel if channel is not None else self.FINANCE_CHNNAEL,
            file=file_path,
            title=title,
            initial_comment=f"📢 {comment}."
        )
