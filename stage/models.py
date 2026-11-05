from django.db import models
from django.contrib.auth.models import User

class SongProject(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True, blank=True, related_name='projects')
    title = models.CharField(max_length=255, default="In Jesus' Name - Darlene Zschech")
    default_key = models.CharField(max_length=10, default="D")
    bpm = models.FloatField(default=105.0)
    beats_per_bar = models.IntegerField(default=4)
    total_measures = models.IntegerField(default=24)
    audio_file = models.FileField(upload_to='audio_tracks/', null=True, blank=True)
    edit_pin = models.CharField(max_length=64, blank=True, null=True)
    timing_points = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.title} (Key: {self.default_key})"

class Section(models.Model):
    project = models.ForeignKey(SongProject, related_name="sections", on_delete=models.CASCADE)
    start_bar = models.IntegerField(default=1)
    end_bar = models.IntegerField(default=1)
    name = models.CharField(max_length=100, default="Section 1")
    color = models.CharField(max_length=20, default="#facc15")
    song_key = models.CharField(max_length=10, default="C")
    is_new_song = models.BooleanField(default=False)
    song_title = models.CharField(max_length=255, blank=True, default="")
    order = models.IntegerField(default=0)

    class Meta:
        ordering = ['order', 'start_bar']

    def __str__(self):
        return f"{self.name} (Bars {self.start_bar}-{self.end_bar})"

class Measure(models.Model):
    project = models.ForeignKey(SongProject, on_delete=models.CASCADE, related_name='measures')
    bar_index = models.IntegerField()
    chord_line = models.CharField(max_length=255, default="", blank=True)
    lead_line = models.CharField(max_length=255, default="", blank=True)

    class Meta:
        ordering = ['bar_index']
        unique_together = ('project', 'bar_index')

    def __str__(self):
        return f"Bar {self.bar_index}: {self.chord_line}"
