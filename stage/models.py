from django.db import models
from django.contrib.auth.models import User
from django.utils.text import slugify

RESERVED_SLUGS = {"api", "admin", "media", "static", "project", "song", "studio", "new"}

def generate_unique_slug(title, instance_id=None):
    base_slug = slugify(title or "untitled-project")
    if not base_slug:
        base_slug = "project"
    
    # If purely numeric or reserved word, prefix with 'song-'
    if base_slug.isdigit() or base_slug in RESERVED_SLUGS:
        base_slug = f"song-{base_slug}"
    
    slug = base_slug
    counter = 1
    qs = SongProject.objects.all()
    if instance_id:
        qs = qs.exclude(id=instance_id)
        
    while qs.filter(slug=slug).exists():
        counter += 1
        slug = f"{base_slug}-{counter}"
        
    return slug

class SongProject(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True, blank=True, related_name='projects')
    title = models.CharField(max_length=255, default="In Jesus' Name - Darlene Zschech")
    slug = models.SlugField(max_length=255, unique=True, blank=True, null=True)
    default_key = models.CharField(max_length=10, default="D")
    bpm = models.FloatField(default=105.0)
    beats_per_bar = models.IntegerField(default=4)
    total_measures = models.IntegerField(default=24)
    audio_file = models.FileField(upload_to='audio_tracks/', null=True, blank=True)
    edit_pin = models.CharField(max_length=64, blank=True, null=True)
    timing_points = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = generate_unique_slug(self.title, self.id)
        super().save(*args, **kwargs)

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
